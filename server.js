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

app.get('/login', (req, res) => {
  const query = qs.stringify({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    const scopes = 'user-read-playback-state user-read-currently-playing streaming user-modify-playback-state';
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
