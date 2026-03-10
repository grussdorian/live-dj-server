![Deployment passing](https://github.com/grussdorian/live-dj-server/actions/workflows/restart-on-main.yml/badge.svg)


# DJ Server

A Spotify-integrated song request and live playlist management system built with Node.js, Express, Redis, and Socket.io.

## Features

- **Song Requests**: Users submit Spotify track URLs/IDs for approval
- **Admin Dashboard**: Approve/reject requests, manage live playlists
- **Spotify Integration**: Automatic playlist sync with request and live queues
- **Real-time Updates**: Socket.io for instant UI updates
- **Rate Limiting**: 3 requests per minute per IP
- **Admin Auth**: JWT-based session management
- **OAuth 2.0**: Spotify user authentication with scopes for playlist modification

## Tech Stack

- **Backend**: Node.js, Express, Socket.io
- **Database**: Redis (queue storage, rate limiting)
- **Auth**: JWT, Spotify OAuth 2.0
- **Frontend**: Vanilla JS, HTML/CSS

## Setup

### Environment Variables

Create a `.env` file:

```env
NODE_ENV=dev
LOCAL_URL=localhost
PORT=3000
REDIS_URL=redis://localhost:6379
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_REDIRECT_URI=http://localhost:3000/auth/callback
PLAYLIST_REQUESTS_ID=spotify_request_playlist_id
PLAYLIST_LIVE_ID=spotify_live_playlist_id
ADMIN_USER=<user id for admin>
ADMIN_PASS=<password for the user>
ADMIN_JWT_SECRET=your_secret_key
```
Note: For real prod ready app, this way of admin page authentication is gonna go away

### Installation

```bash
npm install
npm start
```

Server runs on `http://localhost:3000`

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/requests` | — | Get pending requests |
| `GET` | `/api/live` | — | Get live playlist |
| `POST` | `/api/request` | — | Submit song request |
| `GET` | `/api/validate` | — | Validate Spotify track |
| `POST` | `/api/admin/login` | — | Admin login |
| `POST` | `/api/admin/approve` | JWT | Approve request → live |
| `POST` | `/api/admin/reject` | JWT | Reject request |
| `POST` | `/api/admin/remove_live` | JWT | Remove from live playlist |
| `GET` | `/auth/spotify` | — | Start Spotify OAuth |
| `GET` | `/auth/callback` | — | Spotify OAuth callback |

## Usage

1. **User**: Visit `/` and paste a Spotify track URL
2. **Admin**: Login at `/admin` with credentials
3. **Approve**: Move requests to live playlist
4. **Sync**: Keep Spotify playlists in sync with Redis queues
