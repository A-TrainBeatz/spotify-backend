const express = require('express');
const axios = require('axios');
const cors = require('cors');
const qs = require('querystring');
const crypto = require('crypto');

require('dotenv').config();

const app = express();

// ============================================================
// CONFIG
// ============================================================

const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

// Example:
// FRONTEND_URL=https://yourusername.github.io
const FRONTEND_URL = https://a-trainbeatz.github.io
  process.env.FRONTEND_URL || 'http://localhost:3000';

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
  console.error('Missing required Spotify environment variables.');
  process.exit(1);
}

// ============================================================
// CORS
// ============================================================

app.use(cors({
  origin: FRONTEND_URL,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// ============================================================
// TOKEN STATE
// ============================================================

// IMPORTANT:
// These are in-memory.
//
// On Render, a restart/redeploy will erase them.
// For a truly persistent application, store the refresh token
// in a database or other persistent secret store.

let access_token = '';
let refresh_token = '';
let token_expires_at = 0;

// Used to prevent several simultaneous requests from attempting
// to refresh the same access token.
let refreshPromise = null;

// ============================================================
// SCOPES
// ============================================================

const SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing'
].join(' ');

// ============================================================
// HELPER: Spotify Basic Auth
// ============================================================

function spotifyAuthHeader() {
  return (
    'Basic ' +
    Buffer
      .from(`${CLIENT_ID}:${CLIENT_SECRET}`)
      .toString('base64')
  );
}

// ============================================================
// LOGIN
// ============================================================

app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');

  // For a production application, store/verify this state.
  // This simple version keeps the existing architecture.
  const params = qs.stringify({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state
  });

  const authorizeURL =
    'https://accounts.spotify.com/authorize?' + params;

  console.log('Redirecting to Spotify authorization.');

  res.redirect(authorizeURL);
});

// ============================================================
// CALLBACK
// ============================================================

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(
      `Spotify authorization failed: ${error}`
    );
  }

  if (!code) {
    return res.status(400).send(
      'No authorization code was provided.'
    );
  }

  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',

      qs.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      }),

      {
        headers: {
          Authorization: spotifyAuthHeader(),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    access_token = response.data.access_token;

    if (response.data.refresh_token) {
      refresh_token = response.data.refresh_token;
    }

    token_expires_at =
      Date.now() + (response.data.expires_in * 1000);

    console.log('Spotify authorization successful.');

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Spotify Connected</title>
        </head>
        <body style="
          background:#121212;
          color:white;
          font-family:Arial,sans-serif;
          text-align:center;
          padding:50px;
        ">
          <h2 style="color:#1DB954;">
            Spotify authorization successful!
          </h2>

          <p>You can close this tab.</p>

          <script>
            setTimeout(() => {
              window.close();
            }, 1500);
          </script>
        </body>
      </html>
    `);

  } catch (err) {
    console.error(
      'Spotify token error:',
      err.response?.data || err.message
    );

    res.status(500).send(
      'Error during Spotify authorization.'
    );
  }
});

// ============================================================
// REFRESH ACCESS TOKEN
// ============================================================

async function refreshAccessToken() {

  if (!refresh_token) {
    throw new Error(
      'No Spotify refresh token available. Visit /login.'
    );
  }

  // If another request is already refreshing the token,
  // wait for that request instead of sending another refresh.
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {

      console.log('Refreshing Spotify access token...');

      const response = await axios.post(
        'https://accounts.spotify.com/api/token',

        qs.stringify({
          grant_type: 'refresh_token',
          refresh_token
        }),

        {
          headers: {
            Authorization: spotifyAuthHeader(),
            'Content-Type':
              'application/x-www-form-urlencoded'
          }
        }
      );

      access_token = response.data.access_token;

      token_expires_at =
        Date.now() +
        (response.data.expires_in * 1000);

      // Spotify may return a replacement refresh token.
      // If it doesn't, KEEP the old one.
      if (response.data.refresh_token) {
        refresh_token = response.data.refresh_token;
      }

      console.log(
        'Spotify access token refreshed successfully.'
      );

      return access_token;

    } catch (err) {

      const spotifyError = err.response?.data;

      console.error(
        'Spotify refresh error:',
        spotifyError || err.message
      );

      // Spotify now uses invalid_grant when the refresh token
      // is expired/revoked.
      if (
        spotifyError?.error === 'invalid_grant'
      ) {
        console.error(
          'Spotify refresh token is expired or revoked.'
        );

        access_token = '';
        refresh_token = '';
        token_expires_at = 0;

        throw new Error(
          'SPOTIFY_REAUTH_REQUIRED'
        );
      }

      throw err;

    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// ============================================================
// GET VALID ACCESS TOKEN
// ============================================================

async function getValidAccessToken() {

  // Refresh one minute before expiration.
  const needsRefresh =
    !access_token ||
    Date.now() >= token_expires_at - 60000;

  if (needsRefresh) {

    if (!refresh_token) {
      throw new Error('SPOTIFY_REAUTH_REQUIRED');
    }

    await refreshAccessToken();
  }

  return access_token;
}

// ============================================================
// STATUS
// ============================================================

app.get('/status', (req, res) => {
  res.json({
    spotifyConnected: !!refresh_token,
    accessTokenAvailable: !!access_token,
    accessTokenExpiresAt: token_expires_at || null
  });
});

// ============================================================
// MANUAL REFRESH
// ============================================================

app.get('/refresh', async (req, res) => {

  try {

    const token = await refreshAccessToken();

    res.json({
      success: true,
      message: 'Spotify access token refreshed.',
      expiresAt: token_expires_at
    });

  } catch (err) {

    console.error(
      'Manual refresh error:',
      err.message
    );

    if (err.message === 'SPOTIFY_REAUTH_REQUIRED') {
      return res.status(401).json({
        success: false,
        requiresLogin: true,
        loginUrl: '/login',
        error:
          'Spotify authorization has expired. Please reconnect.'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to refresh Spotify token.'
    });
  }
});

// ============================================================
// NOW PLAYING
// ============================================================

app.get('/now-playing', async (req, res) => {

  try {

    const token = await getValidAccessToken();

    const response = await axios.get(
      'https://api.spotify.com/v1/me/player',
      {
        headers: {
          Authorization: `Bearer ${token}`
        },

        // Optional but useful for track/episode handling.
        params: {
          additional_types: 'track,episode'
        },

        validateStatus: () => true
      }
    );

    // Spotify uses 204 when nothing is playing.
    if (response.status === 204) {
      return res.status(204).send();
    }

    // Access token expired unexpectedly.
    if (response.status === 401) {

      try {
        await refreshAccessToken();

        const retry = await axios.get(
          'https://api.spotify.com/v1/me/player',
          {
            headers: {
              Authorization:
                `Bearer ${access_token}`
            },
            params: {
              additional_types: 'track,episode'
            },
            validateStatus: () => true
          }
        );

        if (retry.status === 204) {
          return res.status(204).send();
        }

        if (retry.status >= 200 && retry.status < 300) {
          return res.json(retry.data);
        }

      } catch (refreshError) {

        if (
          refreshError.message ===
          'SPOTIFY_REAUTH_REQUIRED'
        ) {
          return res.status(401).json({
            requiresLogin: true,
            loginUrl: '/login',
            error:
              'Spotify authorization expired. Please reconnect.'
          });
        }
      }

      return res.status(401).json({
        requiresLogin: true,
        loginUrl: '/login',
        error:
          'Spotify session expired. Please reconnect.'
      });
    }

    if (response.status === 403) {
      return res.status(403).json({
        error:
          'Spotify denied access to the playback endpoint.'
      });
    }

    if (response.status === 429) {

      return res.status(429).json({
        error:
          'Spotify rate limit reached. Please slow down.'
      });
    }

    if (response.status >= 400) {

      console.error(
        'Spotify playback error:',
        response.data
      );

      return res.status(response.status).json({
        error: 'Spotify playback request failed.',
        spotify: response.data
      });
    }

    res.json(response.data);

  } catch (err) {

    console.error(
      'Now-playing error:',
      err.response?.data || err.message
    );

    if (
      err.message === 'SPOTIFY_REAUTH_REQUIRED'
    ) {
      return res.status(401).json({
        requiresLogin: true,
        loginUrl: '/login',
        error:
          'Spotify authorization expired. Please reconnect.'
      });
    }

    res.status(500).json({
      error: 'Failed to fetch now playing.'
    });
  }
});

// ============================================================
// PLAYER ALIAS
// ============================================================

app.get('/player', async (req, res) => {

  // Keep /player working for compatibility.
  req.url = '/now-playing';

  try {

    const token = await getValidAccessToken();

    const response = await axios.get(
      'https://api.spotify.com/v1/me/player',
      {
        headers: {
          Authorization: `Bearer ${token}`
        },
        params: {
          additional_types: 'track,episode'
        },
        validateStatus: () => true
      }
    );

    if (response.status === 204) {
      return res.status(204).send();
    }

    if (response.status === 401) {
      return res.status(401).json({
        requiresLogin: true,
        loginUrl: '/login',
        error:
          'Spotify session expired. Please reconnect.'
      });
    }

    if (response.status >= 400) {
      return res.status(response.status).json({
        error: 'Spotify playback request failed.',
        spotify: response.data
      });
    }

    res.json(response.data);

  } catch (err) {

    console.error(
      'Player error:',
      err.response?.data || err.message
    );

    if (
      err.message === 'SPOTIFY_REAUTH_REQUIRED'
    ) {
      return res.status(401).json({
        requiresLogin: true,
        loginUrl: '/login',
        error:
          'Spotify authorization expired. Please reconnect.'
      });
    }

    res.status(500).json({
      error:
        'Failed to fetch Spotify playback state.'
    });
  }
});

// ============================================================
// ROOT
// ============================================================

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    spotify: 'A-TrainBeatz backend',
    endpoints: {
      login: '/login',
      callback: '/callback',
      status: '/status',
      refresh: '/refresh',
      nowPlaying: '/now-playing',
      player: '/player'
    }
  });
});

// ============================================================
// SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );
});