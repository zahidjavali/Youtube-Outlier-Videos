import https from "https";

const API_BASE_URL = "https://www.googleapis.com/youtube/v3";
const MAX_RESULTS_PER_PAGE = 50;

async function apiFetch(endpoint, params) {
  const url = new URL(`${API_BASE_URL}/${endpoint}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.append(key, value));

  try {
    const res = await new Promise((resolve, reject) => {
      https.get(url.toString(), (response) => {
        let rawData = "";
        response.on("data", (chunk) => { rawData += chunk; });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(rawData);
            resolve({
              ok: !!(response.statusCode && response.statusCode >= 200 && response.statusCode < 300),
              status: response.statusCode || 500,
              data: parsed,
            });
          } catch (e) {
            resolve({
              ok: false,
              status: response.statusCode || 500,
              data: { error: { message: `Failed to parse JSON response from YouTube: ${rawData.substring(0, 150)}` } },
            });
          }
        });
      }).on("error", (err) => {
        reject(err);
      });
    });

    if (!res.ok) {
      const errorMsg = res.data?.error?.message || `YouTube API request failed with status ${res.status}`;
      throw new Error(errorMsg);
    }
    return res.data;
  } catch (err) {
    throw new Error(`Network or API Error: ${err.message || err}`);
  }
}

async function fetchVideoIdsByChannel(channelInput, apiKey) {
  const trimmedInput = channelInput.trim();
  let channelData = null;

  if (trimmedInput.startsWith("UC")) {
    try {
      const data = await apiFetch("channels", {
        part: "contentDetails",
        id: trimmedInput,
        key: apiKey,
      });
      if (data.items && data.items.length > 0) {
        channelData = data;
      }
    } catch (e) {
      console.warn("Direct channel ID lookup failed:", e.message || e);
    }
  }

  if (!channelData && trimmedInput.startsWith("@")) {
    try {
      const data = await apiFetch("channels", {
        part: "contentDetails",
        forHandle: trimmedInput,
        key: apiKey,
      });
      if (data.items && data.items.length > 0) {
        channelData = data;
      }
    } catch (e) {
      console.warn("forHandle lookup failed:", e.message || e);
    }
  }

  if (!channelData) {
    try {
      const searchData = await apiFetch("search", {
        part: "snippet",
        q: trimmedInput,
        type: "channel",
        maxResults: "1",
        key: apiKey,
      });

      if (searchData.items && searchData.items.length > 0) {
        const foundChannelId = searchData.items[0].id.channelId;
        const data = await apiFetch("channels", {
          part: "contentDetails",
          id: foundChannelId,
          key: apiKey,
        });
        if (data.items && data.items.length > 0) {
          channelData = data;
        }
      }
    } catch (e) {
      console.warn("Search fallback channel resolve failed:", e.message || e);
    }
  }

  if (!channelData || !channelData.items || channelData.items.length === 0) {
    throw new Error(`Could not find a YouTube channel matching "${channelInput}". Please check the Channel ID, name, or handle.`);
  }

  const uploadsPlaylistId = channelData.items[0].contentDetails.relatedPlaylists.uploads;

  const playlistItemsData = await apiFetch("playlistItems", {
    part: "contentDetails",
    playlistId: uploadsPlaylistId,
    maxResults: MAX_RESULTS_PER_PAGE.toString(),
    key: apiKey,
  });

  return (
    playlistItemsData.items
      ?.map((item) => item.contentDetails?.videoId)
      .filter(Boolean) || []
  );
}

async function fetchVideoIdsBySearch(query, apiKey) {
  const searchData = await apiFetch("search", {
    part: "snippet",
    q: query.trim(),
    type: "video",
    maxResults: MAX_RESULTS_PER_PAGE.toString(),
    key: apiKey,
  });

  return (
    searchData.items
      ?.map((item) => item.id?.videoId)
      .filter(Boolean) || []
  );
}

async function fetchAndAnalyzeVideos(query, inputType, apiKey) {
  let videoIds = [];

  if (inputType === "channel") {
    videoIds = await fetchVideoIdsByChannel(query, apiKey);
  } else {
    videoIds = await fetchVideoIdsBySearch(query, apiKey);
  }

  if (videoIds.length === 0) {
    return [];
  }

  const videoDetailsData = await apiFetch("videos", {
    part: "snippet,statistics",
    id: videoIds.join(","),
    key: apiKey,
  });

  const videos = (videoDetailsData.items || []).map((item) => ({
    id: item.id,
    title: item.snippet.title,
    publishedAt: item.snippet.publishedAt,
    thumbnailUrl:
      item.snippet.thumbnails.medium?.url ||
      item.snippet.thumbnails.default?.url ||
      "",
    viewCount: parseInt(item.statistics.viewCount || "0", 10),
    likeCount: parseInt(item.statistics.likeCount || "0", 10),
    commentCount: parseInt(item.statistics.commentCount || "0", 10),
  }));

  return videos;
}

export const handler = async (event, context) => {
  try {
    const query = event.queryStringParameters?.query;
    const type = event.queryStringParameters?.type;

    if (!query) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ error: "Missing search or channel query parameter." }),
      };
    }

    const searchType = type === "channel" ? "channel" : "search";
    let apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey || apiKey.trim() === "" || apiKey === "undefined" || apiKey === "null") {
      apiKey = "AIzaSyDjafYqDX2JgzRNAFss6O7x2gQLdrtA07c";
    }

    const videos = await fetchAndAnalyzeVideos(query, searchType, apiKey);
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
      body: JSON.stringify(videos),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: error.message || "An unknown Netlify serverless function error occurred." }),
    };
  }
};
