const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const app = express();
app.use(cors());

const PORT = Number(process.env.PORT) || 3000;

let accessToken = "";
let tokenExpiresAt = 0;
let refreshPromise = null;

function validateEnvironment() {
  const required = ["CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN"];
  const missing = required.filter(name => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

async function refreshAccessToken() {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      validateEnvironment();

      const credentials = Buffer.from(
        `${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`
      ).toString("base64");

      const response = await axios.post(
        "https://accounts.spotify.com/api/token",
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: process.env.REFRESH_TOKEN
        }).toString(),
        {
          headers: {
            Authorization: `Basic ${credentials}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          timeout: 15000
        }
      );

      if (!response.data?.access_token) {
        throw new Error("Spotify did not return an access token.");
      }

      accessToken = response.data.access_token;

      const expiresIn = Number(response.data.expires_in) || 3600;
      tokenExpiresAt = Date.now() + Math.max(expiresIn - 60, 60) * 1000;

      console.log(
        `Access token refreshed at ${new Date().toLocaleTimeString()}`
      );

      return accessToken;
    } catch (error) {
      accessToken = "";
      tokenExpiresAt = 0;

      console.error(
        "Error refreshing Spotify token:",
        error.response?.data || error.message
      );

      throw error;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function getValidAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt) {
    return accessToken;
  }

  return refreshAccessToken();
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "spotify-backend",
    endpoint: "/now-playing"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    spotifyTokenAvailable: Boolean(accessToken),
    tokenExpiresAt: tokenExpiresAt || null
  });
});

app.get("/now-playing", async (req, res) => {
  try {
    const token = await getValidAccessToken();

    const response = await axios.get(
      "https://api.spotify.com/v1/me/player/currently-playing",
      {
        headers: {
          Authorization: `Bearer ${token}`
        },
        timeout: 15000,
        validateStatus: status => status >= 200 && status < 300
      }
    );

    // Spotify uses HTTP 204 when there is no active playback.
    if (response.status === 204 || !response.data) {
      return res.status(204).end();
    }

    return res.json(response.data);
  } catch (error) {
    const spotifyStatus = error.response?.status;
    const spotifyData = error.response?.data;

    console.error(
      "Error fetching now playing:",
      spotifyData || error.message
    );

    // A token can become invalid before our local expiry estimate.
    // Refresh once and retry the Spotify request.
    if (spotifyStatus === 401) {
      try {
        const newToken = await refreshAccessToken();

        const retry = await axios.get(
          "https://api.spotify.com/v1/me/player/currently-playing",
          {
            headers: {
              Authorization: `Bearer ${newToken}`
            },
            timeout: 15000,
            validateStatus: status => status >= 200 && status < 300
          }
        );

        if (retry.status === 204 || !retry.data) {
          return res.status(204).end();
        }

        return res.json(retry.data);
      } catch (retryError) {
        console.error(
          "Retry after token refresh failed:",
          retryError.response?.data || retryError.message
        );
      }
    }

    if (spotifyStatus === 403) {
      return res.status(403).json({
        error: "Spotify denied the request. Check that the Spotify account and API scopes are configured correctly."
      });
    }

    return res.status(502).json({
      error: "Failed to fetch now playing from Spotify."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Refresh before the token is likely to expire.
// The first request can also refresh it on demand, so startup is not race-prone.
refreshAccessToken().catch(() => {
  console.error("Initial Spotify token refresh failed.");
});

setInterval(() => {
  refreshAccessToken().catch(() => {
    console.error("Scheduled Spotify token refresh failed.");
  });
}, 50 * 60 * 1000);