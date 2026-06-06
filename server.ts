import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";

dotenv.config();

const API_BASE_URL = "https://www.googleapis.com/youtube/v3";
const MAX_RESULTS_PER_PAGE = 50;

async function apiFetch(endpoint: string, params: Record<string, string>) {
  const url = new URL(`${API_BASE_URL}/${endpoint}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.append(key, value));

  const response = await fetch(url.toString());
  const data = await response.json();

  if (!response.ok) {
    const errorMsg = data.error?.message || `API request failed with status ${response.status}`;
    throw new Error(errorMsg);
  }
  return data;
}

async function fetchVideoIdsByChannel(channelInput: string, apiKey: string): Promise<string[]> {
  const trimmedInput = channelInput.trim();
  let channelData: any = null;

  // Step 1: Query channel directly by ID match if it starts with "UC"
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
    } catch (e: any) {
      console.warn("Direct channel ID lookup failed, will try other options:", e.message || e);
    }
  }

  // Step 2: Query by handle if it starts with "@"
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
    } catch (e: any) {
      console.warn("forHandle lookup failed, will try search option:", e.message || e);
    }
  }

  // Step 3: Handle fallback options by searching for channel by query/name
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
    } catch (e: any) {
      console.warn("Search fallback channel resolve failed:", e.message || e);
    }
  }

  if (!channelData || !channelData.items || channelData.items.length === 0) {
    throw new Error(`Could not find a YouTube channel matching "${channelInput}". Please check the Channel ID, name, or handle.`);
  }

  const uploadsPlaylistId = channelData.items[0].contentDetails.relatedPlaylists.uploads;

  // Step 4: Fetch playlist items (videos within Upload playlists)
  const playlistItemsData = await apiFetch("playlistItems", {
    part: "contentDetails",
    playlistId: uploadsPlaylistId,
    maxResults: MAX_RESULTS_PER_PAGE.toString(),
    key: apiKey,
  });

  return (
    playlistItemsData.items
      ?.map((item: any) => item.contentDetails?.videoId)
      .filter(Boolean) || []
  );
}

async function fetchVideoIdsBySearch(query: string, apiKey: string): Promise<string[]> {
  const searchData = await apiFetch("search", {
    part: "snippet",
    q: query.trim(),
    type: "video",
    maxResults: MAX_RESULTS_PER_PAGE.toString(),
    key: apiKey,
  });

  return (
    searchData.items
      ?.map((item: any) => item.id?.videoId)
      .filter(Boolean) || []
  );
}

async function fetchAndAnalyzeVideos(query: string, inputType: "channel" | "search", apiKey: string) {
  let videoIds: string[] = [];

  if (inputType === "channel") {
    videoIds = await fetchVideoIdsByChannel(query, apiKey);
  } else {
    videoIds = await fetchVideoIdsBySearch(query, apiKey);
  }

  if (videoIds.length === 0) {
    return [];
  }

  // Stats batch collection
  const videoDetailsData = await apiFetch("videos", {
    part: "snippet,statistics",
    id: videoIds.join(","),
    key: apiKey,
  });

  const videos = (videoDetailsData.items || []).map((item: any) => ({
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

async function startServer() {
  const app = express();
  const PORT = 3000;

  // API router for analytical gathering
  app.get("/api/analyze", async (req, res) => {
    try {
      const { query, type } = req.query;
      if (!query) {
        return res.status(400).json({ error: "Missing search or channel query parameter." });
      }

      const searchType = type === "channel" ? "channel" : "search";
      let apiKey = process.env.YOUTUBE_API_KEY;
      if (!apiKey || apiKey.trim() === "" || apiKey === "undefined" || apiKey === "null") {
        apiKey = "AIzaSyDjafYqDX2JgzRNAFss6O7x2gQLdrtA07c";
      }

      const videos = await fetchAndAnalyzeVideos(query as string, searchType, apiKey);
      res.json(videos);
    } catch (error: any) {
      console.error("YouTube Analysis Server Error:", error.message || error);
      res.status(500).json({ error: error.message || "An unknown server error occurred while retrieving YouTube details." });
    }
  });

  // Vite integration middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is booted and listening on http://localhost:${PORT}`);
  });
}

startServer();
