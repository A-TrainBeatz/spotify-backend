const express = require('express');
const axios = require('axios');
const cors = require('cors');
const qs = require('querystring');

require('dotenv').config();

const app = express();
app.use(cors());

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
let access_token = '';
let refresh_token = '';
// Add at top if not already present
const cache = {
  analysis: null,
  trackId: null,
  lastFetched: 0,
};

app.get('/audio-analysis', async (req, res) => {
  try {
    // Get current playing track ID
    const currentlyPlayingRes = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: 'Bearer ' + access_token },
    });

    const trackId = currentlyPlayingRes.data?.item?.id;

    if (!trackId) {
      return res.status(404).json({ error: 'No track currently playing' });
    }

    // Cache audio analysis for 5 minutes to reduce API calls
    const now = Date.now();
    if (cache.trackId === trackId && now - cache.lastFetched < 5 * 60 * 1000 && cache.analysis) {
      return res.json(cache.analysis);
    }

    // Fetch audio analysis
    const analysisRes = await axios.get(`https://api.spotify.com/v1/audio-analysis/${trackId}`, {
      headers: { Authorization: 'Bearer ' + access_token },
    });

    cache.analysis = analysisRes.data;
    cache.trackId = trackId;
    cache.lastFetched = now;

    res.json(analysisRes.data);
  } catch (err) {
    console.error('Error fetching audio analysis:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch audio analysis' });
  }
});

app.get('/login', (req, res) => {
  const query = qs.stringify({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'user-read-playback-state user-read-currently-playing',
  });
  res.redirect('https://accounts.spotify.com/authorize?' + query);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code || null;
  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      qs.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    access_token = response.data.access_token;
    refresh_token = response.data.refresh_token;
    res.send('Spotify authorization successful. You can close this tab.');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.send('Error during Spotify auth.');
  }
});

app.get('/refresh', async (req, res) => {
  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      qs.stringify({
        grant_type: 'refresh_token',
        refresh_token,
      }),
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    access_token = response.data.access_token;
    res.send({ success: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send({ success: false });
  }
});

app.get('/now-playing', async (req, res) => {
  try {
    const response = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: {
        Authorization: 'Bearer ' + access_token,
      },
    });
    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send({ error: 'Failed to fetch now playing.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
