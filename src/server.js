require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const env = process.env.NODE_ENV || 'dev';
const LOCAL_URL = process.env.LOCAL_URL || 'localhost';
const PORT = process.env.PORT || 3000;
// robust fetch import: prefer global fetch (Node 18+), otherwise try node-fetch (v2 or v3)
let fetch;
try {
	if (typeof globalThis.fetch === 'function') {
		fetch = globalThis.fetch.bind(globalThis);
	} else {
		// require node-fetch; handle v2 (function) and v3 (module with default)
		const nf = require('node-fetch');
		fetch = (typeof nf === 'function') ? nf : (nf && nf.default) ? nf.default : null;
	}
} catch (e) {
	fetch = (typeof globalThis.fetch === 'function') ? globalThis.fetch.bind(globalThis) : null;
}
if (!fetch) throw new Error('No fetch available. Install node-fetch or run on Node 18+');
const { createClient } = require('redis');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let REDIS_URL = process.env.REDIS_URL || `redis://${LOCAL_URL}:6379`;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
try {
	if (REDIS_PASSWORD) {
		const u = new URL(REDIS_URL);
		if (!u.password) u.password = REDIS_PASSWORD;
		REDIS_URL = u.toString();
	}
} catch (e) {
	console.warn('Invalid REDIS_URL format, using as-is');
}

const redis = createClient({ url: REDIS_URL });
redis.on('error', (err) => console.error('Redis Client Error', err));
(async () => {
	try {
		await redis.connect();
	} catch (e) {
		console.error('Failed to connect to Redis:', e && e.message ? e.message : e);
		if (e && e.message && e.message.includes('NOAUTH')) {
			console.error('Redis authentication required. Set REDIS_PASSWORD in your .env or include credentials in REDIS_URL (redis://:PASSWORD@host:port)');
		}
	}
})();


app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve core pages with friendly routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
// removed dedicated /live page; live playlist shown on landing page now
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
// About page
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'about.html')));

// Admin auth using JWT stored in an HttpOnly cookie
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'password';
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'change_this_secret';
function signAdminToken() { return jwt.sign({ user: ADMIN_USER }, ADMIN_JWT_SECRET, { expiresIn: '12h' }); }
function verifyAdmin(req, res, next) {
	try {
		const token = (req.cookies && req.cookies.admin_jwt) || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
		if (!token) return res.status(401).json({ ok: false, error: 'Not authenticated' });
		const payload = jwt.verify(token, ADMIN_JWT_SECRET);
		if (!payload || payload.user !== ADMIN_USER) return res.status(403).json({ ok: false, error: 'Forbidden' });
		req.admin = payload.user;
		return next();
	} catch (e) { return res.status(401).json({ ok: false, error: 'Invalid token' }); }
}

// Admin login/logout endpoints
app.post('/api/admin/login', (req, res) => {
	const { user, pass } = req.body || {};
  console.log(`Provided credentials: user=${user} pass=${pass ? pass.substring(0, 3) + '...' + pass.slice(-3) : '(empty)'}`);
  console.log(`Expected credentials: user=${ADMIN_USER} pass=${ADMIN_PASS ? ADMIN_PASS.substring(0, 3) + '...' + ADMIN_PASS.slice(-3) : '(empty)'}`);
	if (user !== ADMIN_USER || pass !== ADMIN_PASS) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

	const token = signAdminToken();
	res.cookie('admin_jwt', token, { httpOnly: true, sameSite: 'lax' });
	return res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
	res.clearCookie('admin_jwt');
	res.json({ ok: true });
});
app.get('/api/admin/me', (req, res) => {
	try {
		const token = (req.cookies && req.cookies.admin_jwt) || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
		if (!token) return res.json({ ok: true, auth: false });
		const payload = jwt.verify(token, ADMIN_JWT_SECRET);
		return res.json({ ok: true, auth: !!payload });
	} catch (e) { return res.json({ ok: true, auth: false }); }
});

// Helpers: Spotify authorization and API helpers
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
let SPOTIFY_REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN; // set after initial OAuth or loaded from token file
const tokenFile = path.join(__dirname, '..', 'spotify_tokens.json');
// load persisted refresh token if present
if (!SPOTIFY_REFRESH_TOKEN && fs.existsSync(tokenFile)) {
	try {
		const jf = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
		if (jf && jf.refresh_token) SPOTIFY_REFRESH_TOKEN = jf.refresh_token;
	} catch (e) { console.warn('Failed to read spotify_tokens.json', e); }
}
const PLAYLIST_REQUESTS = process.env.PLAYLIST_REQUESTS_ID || process.env.ISC_SONG_REQUESTS_PLAYLIST_ID;
const PLAYLIST_LIVE = process.env.PLAYLIST_LIVE_ID || process.env.ISC_LIVE_PLAYLIST_ID;

// Separate token caches — user tokens (from refresh_token) can write playlists,
// client_credentials tokens are read-only. Mixing them up causes 403.
let _userToken = null;
let _userTokenExpiry = 0;
let _clientToken = null;
let _clientTokenExpiry = 0;

// Get a user-scoped access token (for playlist writes). Falls back to client_credentials for reads.
async function getSpotifyAccessToken() {
	if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) throw new Error('Spotify client not configured');

	// If we have a refresh token, ALWAYS use the user token path
	if (SPOTIFY_REFRESH_TOKEN) {
		if (_userToken && Date.now() < _userTokenExpiry) return _userToken;
		console.log('[Spotify] Refreshing USER access token...');
		const body = new URLSearchParams();
		body.append('grant_type', 'refresh_token');
		body.append('refresh_token', SPOTIFY_REFRESH_TOKEN);
		const res = await fetch('https://accounts.spotify.com/api/token', {
			method: 'POST',
			headers: {
				Authorization: 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: body.toString(),
		});
		const data = await res.json();
		if (!data.access_token) {
			console.error('[Spotify] Failed to refresh user token:', JSON.stringify(data));
			throw new Error('Failed to refresh access token: ' + JSON.stringify(data));
		}
		console.log('[Spotify] Got USER token. Scopes:', data.scope);
		// Spotify may rotate refresh tokens
		if (data.refresh_token && data.refresh_token !== SPOTIFY_REFRESH_TOKEN) {
			SPOTIFY_REFRESH_TOKEN = data.refresh_token;
			try { fs.writeFileSync(tokenFile, JSON.stringify({ refresh_token: data.refresh_token, scope: data.scope, obtainedAt: Date.now() }, null, 2)); } catch (e) {}
		}
		_userToken = data.access_token;
		_userTokenExpiry = Date.now() + ((data.expires_in || 3600) - 120) * 1000;
		return _userToken;
	}

	// No refresh token — fall back to client_credentials (read-only! cannot write playlists)
	if (_clientToken && Date.now() < _clientTokenExpiry) return _clientToken;
	console.log('[Spotify] No refresh token — using CLIENT_CREDENTIALS (read-only)');
	const body = new URLSearchParams();
	body.append('grant_type', 'client_credentials');
	const res = await fetch('https://accounts.spotify.com/api/token', {
		method: 'POST',
		headers: {
			Authorization: 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: body.toString(),
	});
	const data = await res.json();
	if (!data.access_token) throw new Error('Failed to fetch client access token: ' + JSON.stringify(data));
	_clientToken = data.access_token;
	_clientTokenExpiry = Date.now() + ((data.expires_in || 3600) - 120) * 1000;
	return _clientToken;
}

function clearTokenCache() {
	_userToken = null;
	_userTokenExpiry = 0;
	_clientToken = null;
	_clientTokenExpiry = 0;
}

function extractTrackId(input) {
	if (!input) return null;
	// strip tracking params
	const clean = input.split('?')[0];
	// spotify:track:ID
	const m1 = clean.match(/spotify:track:([A-Za-z0-9]{22})/);
	if (m1) return m1[1];
	// https://open.spotify.com/track/ID
	const m2 = clean.match(/open\.spotify\.com\/track\/([A-Za-z0-9]{22})/);
	if (m2) return m2[1];
	// maybe it's just an ID
	const m3 = clean.match(/^([A-Za-z0-9]{22})$/);
	if (m3) return m3[1];
	return null;
}

async function getTrackInfo(trackId) {
	const token = await getSpotifyAccessToken();
	const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (res.status === 404) return null;
	const data = await res.json();
	if (data && data.id) return {
		id: data.id,
		uri: data.uri,
		title: data.name,
		artists: data.artists.map(a=>a.name).join(', '),
		albumImage: (data.album && data.album.images && data.album.images[0]) ? data.album.images[0].url : null,
	};
	return null;
}

async function addTrackToPlaylist(playlistId, trackUri) {
	if (!SPOTIFY_REFRESH_TOKEN) {
		throw new Error('No Spotify user linked — cannot write to playlists. Visit /auth/spotify to link.');
	}
	const token = await getSpotifyAccessToken();
	const url = `https://api.spotify.com/v1/playlists/${playlistId}/items`;
	console.log(`[Spotify] POST ${url}`, { trackUri, tokenPrefix: token.substring(0, 20) + '...', hasRefreshToken: !!SPOTIFY_REFRESH_TOKEN });
	const res = await fetch(url, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ uris: [trackUri], position: 0 }),
	});
	const text = await res.text();
	let body;
	try { body = text ? JSON.parse(text) : {}; } catch(e){ body = { raw: text }; }
	if (!res.ok){
		console.error('[Spotify] addTrack FAILED', { status: res.status, body, playlistId, trackUri, tokenPrefix: token.substring(0, 20) + '...' });
		if (res.status === 403) {
			// Extra diagnosis for 403
			try {
				const meRes = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token}` } });
				const me = meRes.ok ? await meRes.json() : null;
				console.error('[Spotify] 403 debug — token belongs to:', me ? `${me.display_name} (${me.id})` : 'UNKNOWN (not a user token?)');
				if (!me) console.error('[Spotify] 403 debug — /v1/me failed, this may be a client_credentials token!');
			} catch(e) { console.error('[Spotify] 403 debug — /v1/me check failed:', e.message); }
		}
		throw new Error('Spotify addTrack failed: ' + (body.error && body.error.message ? body.error.message : JSON.stringify(body)));
	}
		console.log(`[Spotify] addTrack OK`, { playlistId, snapshot: body.snapshot_id });
		// persist snapshot for later remove operations
		try { if (body && body.snapshot_id) await savePlaylistSnapshot(playlistId, body.snapshot_id); } catch (e) { console.warn('Failed to save playlist snapshot', e); }
		return body;
}

async function removeTrackFromPlaylist(playlistId, trackUri) {
	if (!SPOTIFY_REFRESH_TOKEN) {
		throw new Error('No Spotify user linked — cannot write to playlists. Visit /auth/spotify to link.');
	}
	const token = await getSpotifyAccessToken();
	console.log(`[Spotify] DELETE playlist items`, { playlistId, trackUri, tokenPrefix: token.substring(0, 20) + '...' });
	// Spotify now prefers DELETE against /playlists/{playlist_id}/items with items + snapshot_id
	// obtain snapshot id from Redis or fetch playlist if missing
	let snapshot = await getPlaylistSnapshot(playlistId);
	if (!snapshot) {
		try {
			const pr = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, { headers: { Authorization: `Bearer ${token}` } });
			if (pr.ok) {
				const pj = await pr.json();
				snapshot = pj && pj.snapshot_id;
				if (snapshot) await savePlaylistSnapshot(playlistId, snapshot);
			}
		} catch (e) { /* ignore */ }
	}
	const deleteUrl = `https://api.spotify.com/v1/playlists/${playlistId}/items`;
	const deleteBody = snapshot ? { items: [{ uri: trackUri }], snapshot_id: snapshot } : { items: [{ uri: trackUri }] };
	const res = await fetch(deleteUrl, {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(deleteBody),
	});
	const text = await res.text();
	let body;
	try { body = text ? JSON.parse(text) : {}; } catch(e){ body = { raw: text }; }
	if (!res.ok) {
		console.error('[Spotify] removeTrack FAILED', { status: res.status, body });
		// extra diagnostics for 403/401
		try {
			const meRes = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token}` } });
			const me = meRes.ok ? await meRes.json() : null;
			const plRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, { headers: { Authorization: `Bearer ${token}` } });
			const pl = plRes.ok ? await plRes.json() : null;
			const meId = me && me.id ? me.id : '<unknown>';
			const ownerId = pl && pl.owner && pl.owner.id ? pl.owner.id : '<unknown>';
			const detail = (body && body.error && body.error.message) ? body.error.message : JSON.stringify(body);
			// If Spotify returned a new snapshot in the response body, persist it
			try { if (body && body.snapshot_id) await savePlaylistSnapshot(playlistId, body.snapshot_id); } catch(e){}
			throw new Error(`Spotify removeTrack failed: ${res.status} ${res.statusText} - ${detail} (tokenUser=${meId} playlistOwner=${ownerId})`);
		} catch (e) {
			throw new Error('Spotify removeTrack failed: ' + (body.error && body.error.message ? body.error.message : JSON.stringify(body)));
		}
	}
	return body;
}

// Check whether the current authorized user can modify the given playlist
async function canModifyPlaylist(playlistId){
	try{
		const token = await getSpotifyAccessToken();
		const [rMe, rPl] = await Promise.all([
			fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token}` } }),
			fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, { headers: { Authorization: `Bearer ${token}` } }),
		]);
		const me = await (rMe.ok ? rMe.json() : null);
		const pl = await (rPl.ok ? rPl.json() : null);
		const ownerId = pl && pl.owner && pl.owner.id;
		const meId = me && me.id;
		const can = !!(meId && ownerId && meId === ownerId);
		return { canModify: can, me: me || null, playlistOwner: ownerId || null };
	}catch(e){
		console.warn('canModifyPlaylist check failed', e);
		return { canModify: false, me: null, playlistOwner: null };
	}
}

// Safe add/remove wrappers — try the operation directly, return {ok, error} instead of throwing
async function tryAddToPlaylist(playlistId, trackUri){
	try{
		const body = await addTrackToPlaylist(playlistId, trackUri);
		return { ok: true, body };
	}catch(e){
		return { ok: false, error: (e && e.message) ? e.message : String(e) };
	}
}

async function tryRemoveFromPlaylist(playlistId, trackUri){
	try{
		const body = await removeTrackFromPlaylist(playlistId, trackUri);
		return { ok: true, body };
	}catch(e){
		return { ok: false, error: (e && e.message) ? e.message : String(e) };
	}
}

// Helpers to persist the last snapshot id per playlist in Redis
function playlistSnapshotKey(playlistId){ return `spotify:playlist:${playlistId}:snapshot`; }
async function savePlaylistSnapshot(playlistId, snapshotId){ try{ if(snapshotId) await redis.set(playlistSnapshotKey(playlistId), snapshotId); }catch(e){} }
async function getPlaylistSnapshot(playlistId){ try{ const v = await redis.get(playlistSnapshotKey(playlistId)); return v || null; }catch(e){ return null; } }

// Redis keys
const REDIS_REQ_KEY = 'queue:requests';
const REDIS_LIVE_KEY = 'queue:live';
const REDIS_REQ_SET = 'set:requests';
const REDIS_LIVE_SET = 'set:live';

// Rate limiter: max 3 per minute per IP
async function checkRateLimit(ip) {
  if (env === 'dev') return true; // disable rate limit in dev for easier testing
	const key = `rate:${ip}`;
	const now = await redis.incr(key);
	if (now === 1) {
		await redis.expire(key, 60);
	}
	return now <= 3;
}

// API routes
app.get('/api/validate', async (req, res) => {
	try {
		const { url } = req.query;
		const id = extractTrackId(url);
		if (!id) return res.status(400).json({ ok: false, error: 'Invalid Spotify track URL/ID' });
		const info = await getTrackInfo(id);
		if (!info) return res.status(404).json({ ok: false, error: 'Track not found' });
		return res.json({ ok: true, track: info });
	} catch (err) {
		console.error(err);
		res.status(500).json({ ok: false, error: err.message });
	}
});

app.post('/api/request', async (req, res) => {
	try {
		const ip = req.ip || req.connection.remoteAddress;
		// rate limit per IP
		const allowed = await checkRateLimit(ip);
		if (!allowed) return res.status(429).json({ ok: false, error: 'Rate limit exceeded' });

		const payload = req.body || {};
		const rawInput = payload.url || payload.uri || payload.track || payload.trackUrl || payload.trackUri || payload.id || payload.trackId || '';
		const id = extractTrackId(rawInput);
		if (!id) return res.status(400).json({ ok: false, error: 'Invalid Spotify track URL/ID' });

		const info = await getTrackInfo(id);
		if (!info) return res.status(404).json({ ok: false, error: 'Track not found' });

		// ensure uniqueness: check sets for duplicates
		const inReq = await redis.sIsMember(REDIS_REQ_SET, info.id);
		const inLive = await redis.sIsMember(REDIS_LIVE_SET, info.id);
		if (inReq || inLive) return res.status(409).json({ ok: false, error: 'Track already requested or already in live' });

		// prepare item
		const item = { addedAt: Date.now(), track: info };
		// try adding to Spotify request playlist, but don't fail the request if Spotify forbids it
		if (PLAYLIST_REQUESTS) {
			const addRes = await tryAddToPlaylist(PLAYLIST_REQUESTS, info.uri);
			if (addRes.ok) item.spotifyAddedToRequests = true;
			else { item.spotifyAddedToRequests = false; item.spotifyError = addRes.error; console.warn('add to requests playlist failed', addRes.error); }
		}

		await redis.rPush(REDIS_REQ_KEY, JSON.stringify(item));
		await redis.sAdd(REDIS_REQ_SET, info.id);
		io.emit('requests_update', await getRequests());
		return res.json({ ok: true, request: item });
	} catch (err) {
		console.error(err);
		res.status(500).json({ ok: false, error: err.message });
	}
});

async function getRequests() {
	const raw = await redis.lRange(REDIS_REQ_KEY, 0, -1);
	return raw.map(r => JSON.parse(r));
}

async function getLive() {
	const raw = await redis.lRange(REDIS_LIVE_KEY, 0, -1);
	return raw.map(r => JSON.parse(r));
}

app.get('/api/requests', async (req, res) => {
	try {
		const data = await getRequests();
		res.json({ ok: true, requests: data });
	} catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/live', async (req, res) => {
	try {
		const data = await getLive();
		res.json({ ok: true, live: data });
	} catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Admin approves a request (basic auth required)
app.post('/api/admin/approve', verifyAdmin, async (req, res) => {
	try {
		const { trackId } = req.body;
		if (!trackId) return res.status(400).json({ ok: false, error: 'Missing trackId' });
		// find the request in redis and remove first occurrence
		const list = await redis.lRange(REDIS_REQ_KEY, 0, -1);
		let removedItem = null;
		for (const item of list) {
			const obj = JSON.parse(item);
			if (obj.track && obj.track.id === trackId) {
				// remove this specific element
				await redis.lRem(REDIS_REQ_KEY, 1, item);
				removedItem = obj;
				break;
			}
		}
		if (!removedItem) return res.status(404).json({ ok: false, error: 'Request not found' });

				// remove from requests playlist and set, add to live playlist and set, push to live queue
				if (PLAYLIST_REQUESTS) {
					const rr = await tryRemoveFromPlaylist(PLAYLIST_REQUESTS, removedItem.track.uri);
					if (!rr.ok) console.warn('remove from playlist failed', rr.error);
				}
				await redis.sRem(REDIS_REQ_SET, removedItem.track.id);
				if (PLAYLIST_LIVE) {
					const ra = await tryAddToPlaylist(PLAYLIST_LIVE, removedItem.track.uri);
					if (!ra.ok) console.warn('add to live playlist failed', ra.error);
				}
		await redis.rPush(REDIS_LIVE_KEY, JSON.stringify(removedItem));
		await redis.sAdd(REDIS_LIVE_SET, removedItem.track.id);

		// emit updates
		io.emit('requests_update', await getRequests());
		io.emit('live_update', await getLive());

		res.json({ ok: true, addedToLive: true, track: removedItem.track });
	} catch (err) { console.error(err); res.status(500).json({ ok: false, error: err.message }); }
});

// Admin reject: remove request without adding to live
app.post('/api/admin/reject', verifyAdmin, async (req, res) => {
	try {
		const { trackId } = req.body;
		if (!trackId) return res.status(400).json({ ok: false, error: 'Missing trackId' });
		const list = await redis.lRange(REDIS_REQ_KEY, 0, -1);
		let removedItem = null;
		for (const item of list) {
			const obj = JSON.parse(item);
			if (obj.track && obj.track.id === trackId) {
				await redis.lRem(REDIS_REQ_KEY, 1, item);
				removedItem = obj; break;
			}
		}
		if (!removedItem) return res.status(404).json({ ok: false, error: 'Request not found' });
				if (PLAYLIST_REQUESTS) {
					const rr = await tryRemoveFromPlaylist(PLAYLIST_REQUESTS, removedItem.track.uri);
					if (!rr.ok) console.warn('remove from playlist failed', rr.error);
				}
		await redis.sRem(REDIS_REQ_SET, removedItem.track.id);
		io.emit('requests_update', await getRequests());
		return res.json({ ok: true, rejected: true, track: removedItem.track });
	} catch (err) { console.error(err); res.status(500).json({ ok: false, error: err.message }); }
});

// Admin: retry adding a queued request to Spotify requests playlist
app.post('/api/admin/retry_spotify_request', verifyAdmin, async (req, res) => {
	try {
		const { trackId } = req.body;
		if (!trackId) return res.status(400).json({ ok: false, error: 'Missing trackId' });
		// find request in redis list
		const list = await redis.lRange(REDIS_REQ_KEY, 0, -1);
		let foundIndex = -1;
		let foundObj = null;
		for (let i=0;i<list.length;i++){
			const obj = JSON.parse(list[i]);
			if (obj.track && obj.track.id === trackId){ foundIndex = i; foundObj = obj; break; }
		}
		if (!foundObj) return res.status(404).json({ ok: false, error: 'Request not found' });
		if (!PLAYLIST_REQUESTS) return res.status(400).json({ ok: false, error: 'No PLAYLIST_REQUESTS configured' });
		try {
			const r = await tryAddToPlaylist(PLAYLIST_REQUESTS, foundObj.track.uri);
			if (r.ok) { foundObj.spotifyAddedToRequests = true; delete foundObj.spotifyError; }
			else { foundObj.spotifyAddedToRequests = false; foundObj.spotifyError = r.error; }
		} catch (e) {
			foundObj.spotifyAddedToRequests = false;
			foundObj.spotifyError = (e && e.message) ? e.message : String(e);
		}
		// replace the item at index
		await redis.lSet(REDIS_REQ_KEY, foundIndex, JSON.stringify(foundObj));
		io.emit('requests_update', await getRequests());
		return res.json({ ok: true, updated: foundObj });
	} catch (err) { console.error(err); res.status(500).json({ ok: false, error: err.message }); }
});

// Admin remove from live: remove from live queue and from Spotify live playlist
app.post('/api/admin/remove_live', verifyAdmin, async (req, res) => {
	try {
		const { trackId } = req.body;
		if (!trackId) return res.status(400).json({ ok: false, error: 'Missing trackId' });
		const list = await redis.lRange(REDIS_LIVE_KEY, 0, -1);
		let removedItem = null;
		for (const item of list) {
			const obj = JSON.parse(item);
			if (obj.track && obj.track.id === trackId) {
				await redis.lRem(REDIS_LIVE_KEY, 1, item);
				removedItem = obj; break;
			}
		}
		if (!removedItem) return res.status(404).json({ ok: false, error: 'Live track not found' });
				if (PLAYLIST_LIVE) {
					const r = await tryRemoveFromPlaylist(PLAYLIST_LIVE, removedItem.track.uri);
					if (!r.ok) console.warn('remove from live playlist failed', r.error);
				}
		await redis.sRem(REDIS_LIVE_SET, removedItem.track.id);
		io.emit('live_update', await getLive());
		return res.json({ ok: true, removedFromLive: true, track: removedItem.track });
	} catch (err) { console.error(err); res.status(500).json({ ok: false, error: err.message }); }
});

// Verify playlist details (useful to check playlist id correctness)
app.get('/api/playlist/:id', async (req, res) => {
	try {
		const id = req.params.id;
		const token = await getSpotifyAccessToken();
		const r = await fetch(`https://api.spotify.com/v1/playlists/${id}`, { headers: { Authorization: `Bearer ${token}` } });
		const text = await r.text(); let body;
		try { body = text ? JSON.parse(text) : {}; } catch(e){ body = { raw: text }; }
		if (!r.ok) return res.status(400).json({ ok: false, error: body.error || body });
		return res.json({ ok: true, playlist: body });
	} catch (err) { console.error(err); res.status(500).json({ ok: false, error: err.message }); }
});

// Return current authorized Spotify user (helps debug permissions)
app.get('/api/spotify/me', async (req, res) => {
	try {
		const token = await getSpotifyAccessToken();
		const r = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token}` } });
		const text = await r.text(); let body;
		try { body = text ? JSON.parse(text) : {}; } catch(e){ body = { raw: text }; }
		if (!r.ok) return res.status(400).json({ ok: false, error: body.error || body });
		return res.json({ ok: true, me: body });
	} catch (err) { console.error(err); res.status(500).json({ ok: false, error: err.message }); }
});

// Compute the redirect URI once — prefer .env, fall back to localhost
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || `http://${LOCAL_URL}:${PORT}/auth/callback`;
console.log('[Spotify] Redirect URI:', SPOTIFY_REDIRECT_URI);

// Track used auth codes to prevent double-exchange (causes "invalid_grant")
const _usedCodes = new Set();

// Spotify OAuth — always clears old tokens and forces re-consent to ensure correct scopes
app.get('/auth/spotify', (req, res) => {
	if (!SPOTIFY_CLIENT_ID) return res.status(500).send('Missing SPOTIFY_CLIENT_ID in .env');

	// Clear any stale tokens so we get a completely fresh authorization
	try { if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile); } catch (e) {}
	SPOTIFY_REFRESH_TOKEN = undefined;
	clearTokenCache();
	console.log('[Spotify] Starting OAuth flow — cleared all cached tokens');

	const state = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
	res.cookie('spotify_oauth_state', state, { httpOnly: true, sameSite: 'lax', path: '/' });
	const redirect = new URL('https://accounts.spotify.com/authorize');
	redirect.searchParams.set('client_id', SPOTIFY_CLIENT_ID);
	redirect.searchParams.set('response_type', 'code');
	redirect.searchParams.set('redirect_uri', SPOTIFY_REDIRECT_URI);
	redirect.searchParams.set('scope', 'playlist-modify-public playlist-modify-private playlist-read-private playlist-read-collaborative');
	redirect.searchParams.set('show_dialog', 'true'); // ALWAYS force consent dialog so Spotify grants fresh scopes
	redirect.searchParams.set('state', state);
	res.redirect(redirect.toString());
});

app.get('/auth/callback', async (req, res) => {
	// Handle Spotify error redirect (user denied, etc.)
	if (req.query.error) {
		console.error('[Spotify] OAuth error:', req.query.error, req.query.error_description);
		return res.status(400).send(`<h2>Spotify authorization failed</h2><p>${req.query.error}: ${req.query.error_description || ''}</p><p><a href="/auth/spotify">Try again</a></p>`);
	}

	const code = req.query.code;
	if (!code) return res.status(400).send('Missing code');

	// Prevent double-exchange of the same authorization code
	if (_usedCodes.has(code)) {
		console.warn('[Spotify] Duplicate callback detected — code already exchanged, redirecting to admin');
		return res.redirect('/admin');
	}
	_usedCodes.add(code);
	// Clean up old codes after 5 min to prevent memory leak
	setTimeout(() => _usedCodes.delete(code), 5 * 60 * 1000);

	// Verify state cookie then clear it
	const state = req.query.state;
	const cookieState = req.cookies && req.cookies.spotify_oauth_state;
	res.clearCookie('spotify_oauth_state', { path: '/' });
	if (!state || !cookieState || state !== cookieState) {
		console.warn('[Spotify] OAuth state mismatch (non-fatal — may be caused by localhost vs 127.0.0.1)', { queryState: state, cookieState: cookieState || '<missing>' });
	}

	const body = new URLSearchParams();
	body.append('grant_type', 'authorization_code');
	body.append('code', code);
	body.append('redirect_uri', SPOTIFY_REDIRECT_URI);

	console.log('[Spotify] Exchanging authorization code for tokens...');
	const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
		method: 'POST',
		headers: {
			Authorization: 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: body.toString(),
	});
	const data = await tokenRes.json();

	// Log full exchange result (except secrets)
	console.log('[Spotify] Token exchange result:', {
		has_access_token: !!data.access_token,
		has_refresh_token: !!data.refresh_token,
		scope: data.scope,
		expires_in: data.expires_in,
		error: data.error,
		error_description: data.error_description,
	});

	// Handle token exchange failure
	if (data.error) {
		return res.status(400).send(`<h2>Token exchange failed</h2><p>${data.error}: ${data.error_description || ''}</p><p><a href="/auth/spotify">Try again</a></p>`);
	}

	// Must have a refresh token to persist
	if (!data.refresh_token) {
		return res.status(400).send(`<h2>Authorization incomplete</h2><p>Spotify did not return a refresh token. This usually means the app was auto-approved with a stale grant.</p><p><a href="/auth/spotify">Try again</a> — make sure to click <strong>Agree</strong> on the Spotify consent page.</p>`);
	}

	// Verify that the granted scopes include playlist-modify
	const grantedScopes = (data.scope || '').split(' ');
	const hasModifyPublic = grantedScopes.includes('playlist-modify-public');
	const hasModifyPrivate = grantedScopes.includes('playlist-modify-private');
	if (!hasModifyPublic || !hasModifyPrivate) {
		console.warn('[Spotify] ⚠️ Missing playlist-modify scopes! Granted:', data.scope);
	}

	// Persist refresh token + scopes
	try {
		fs.writeFileSync(tokenFile, JSON.stringify({
			refresh_token: data.refresh_token,
			scope: data.scope,
			obtainedAt: Date.now(),
		}, null, 2));
		SPOTIFY_REFRESH_TOKEN = data.refresh_token;
		// Cache the access token as a USER token (this is critical!)
		_userToken = data.access_token;
		_userTokenExpiry = Date.now() + ((data.expires_in || 3600) - 120) * 1000;
		console.log('[Spotify] ✅ Refresh token saved, user access token cached');
	} catch (e) { console.warn('[Spotify] Failed to save refresh token', e); }

	// Show result page with scope verification
	try {
		const r = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${data.access_token}` } });
		const me = await r.json();
		const scopeHtml = (!hasModifyPublic || !hasModifyPrivate)
			? `<p style="color:orange">⚠️ Missing playlist-modify scopes! Granted: <code>${data.scope}</code>. Playlist writes will fail. <a href="/auth/spotify">Re-authorize</a></p>`
			: `<p style="color:green">✅ Scopes OK: <code>${data.scope}</code></p>`;
		res.send(`<h2>Spotify authorization complete</h2><p>Authorized as: <strong>${me && me.id ? `${me.display_name || ''} (${me.id})` : 'Unknown'}</strong></p>${scopeHtml}<p><a href="/admin">Return to Admin</a></p>`);
	} catch (e) {
		res.send(`<h2>Spotify authorization complete</h2><p>Refresh token saved. Scopes: ${data.scope || 'unknown'}</p><p><a href="/admin">Return to Admin</a></p>`);
	}
});

// Relink: clear persisted refresh token.
// If called via fetch (from admin JS), return JSON. If called from browser, redirect.
app.get('/auth/relink', (req, res) => {
	try { if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile); } catch (e) { console.warn('Failed to delete tokenFile', e); }
	SPOTIFY_REFRESH_TOKEN = undefined;
	clearTokenCache();
	console.log('[Spotify] Relink: cleared all tokens');
	// If called via fetch/XHR, return JSON (don't redirect — fetch follows redirects badly)
	const acceptsJson = (req.headers.accept || '').includes('application/json') || (req.headers['x-requested-with'] === 'XMLHttpRequest');
	if (acceptsJson) return res.json({ ok: true, cleared: true });
	res.redirect('/auth/spotify');
});

// Spotify link status + owner match helper
app.get('/api/spotify/status', async (req, res) => {
	try {
		const persisted = (fs.existsSync(tokenFile) && JSON.parse(fs.readFileSync(tokenFile,'utf8')).refresh_token) || SPOTIFY_REFRESH_TOKEN;
		const linked = !!persisted;
		let me = null; let playlistOwner = null; let ownerMatch = null;
		if (linked) {
			try {
				const token = await getSpotifyAccessToken();
				const r = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token}` } });
				me = await r.json();
			} catch (e) { console.warn('spotify/status: failed to get me', e); }
			try {
				if (PLAYLIST_REQUESTS) {
					const r2 = await fetch(`https://api.spotify.com/v1/playlists/${PLAYLIST_REQUESTS}`, { headers: { Authorization: `Bearer ${await getSpotifyAccessToken()}` } });
					const p = await r2.json();
					playlistOwner = p && p.owner && p.owner.id;
				}
			} catch (e) { console.warn('spotify/status: failed to get playlist owner', e); }
			ownerMatch = !!(me && me.id && playlistOwner && me.id === playlistOwner);
		}
		res.json({ ok: true, linked: !!linked, me, playlistOwner, ownerMatch });
	} catch (err) { console.error(err); res.status(500).json({ ok: false, error: err.message }); }
});

// Socket.io connections
io.on('connection', async (socket) => {
	// clients can request initial data
	socket.on('get_live', async () => {
		socket.emit('live_update', await getLive());
	});
	socket.on('get_requests', async () => {
		socket.emit('requests_update', await getRequests());
	});
});

// Diagnostic endpoint: test full Spotify write chain end-to-end (admin-only)
app.get('/api/spotify/test-add', verifyAdmin, async (req, res) => {
	const results = { steps: [] };
	try {
		// Step 1: Get access token and identify grant type
		const hasRefresh = !!SPOTIFY_REFRESH_TOKEN;
		results.hasRefreshToken = hasRefresh;
		if (!hasRefresh) {
			results.steps.push({ step: 'token', ok: false, error: 'No refresh token — using client_credentials (cannot write playlists)' });
			return res.json({ ok: false, results });
		}
		const token = await getSpotifyAccessToken();
		results.steps.push({ step: 'token', ok: true, tokenPrefix: token.substring(0, 20) + '...' });

		// Step 2: Verify it's a user token
		const meRes = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token}` } });
		if (meRes.ok) {
			const me = await meRes.json();
			results.me = { id: me.id, display_name: me.display_name };
			results.steps.push({ step: 'identify_user', ok: true, userId: me.id });
		} else {
			results.steps.push({ step: 'identify_user', ok: false, status: meRes.status, error: 'Cannot identify user — token may be client_credentials' });
			return res.json({ ok: false, results });
		}

		// Step 3: Check playlist
		const plId = PLAYLIST_REQUESTS || PLAYLIST_LIVE;
		if (!plId) {
			results.steps.push({ step: 'playlist', ok: false, error: 'No playlist ID configured' });
			return res.json({ ok: false, results });
		}
		const plRes = await fetch(`https://api.spotify.com/v1/playlists/${plId}`, { headers: { Authorization: `Bearer ${token}` } });
		if (plRes.ok) {
			const pl = await plRes.json();
			results.playlist = { id: pl.id, name: pl.name, owner: pl.owner && pl.owner.id, public: pl.public, collaborative: pl.collaborative, tracks_total: pl.tracks && pl.tracks.total };
			results.ownerMatch = results.me && results.me.id === results.playlist.owner;
			results.steps.push({ step: 'playlist', ok: true, ownerMatch: results.ownerMatch });
		} else {
			results.steps.push({ step: 'playlist', ok: false, status: plRes.status, error: 'Cannot read playlist' });
			return res.json({ ok: false, results });
		}

		// Step 4: Try to add a test track (Rick Astley - Never Gonna Give You Up)
		const testUri = 'spotify:track:4cOdK2wGLETKBW3PvgPWqT';
		const addRes = await fetch(`https://api.spotify.com/v1/playlists/${plId}/items`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ uris: [testUri], position: 0 }),
		});
		const addText = await addRes.text();
		let addBody;
		try { addBody = JSON.parse(addText); } catch(e) { addBody = { raw: addText }; }
		if (addRes.ok) {
			results.steps.push({ step: 'add_track', ok: true, snapshot: addBody.snapshot_id });
			// Step 5: Remove the test track using the new helper which includes snapshot handling
			const rem = await tryRemoveFromPlaylist(plId, testUri);
			results.steps.push({ step: 'remove_track', ok: rem.ok, error: rem.error || null });
			if (rem.ok && rem.body && rem.body.snapshot_id) results.steps.push({ step: 'remove_snapshot_saved', ok: true, snapshot: rem.body.snapshot_id });
		} else {
			results.steps.push({ step: 'add_track', ok: false, status: addRes.status, body: addBody });
			// Extra: check response headers for clues
			const headers = {};
			addRes.headers.forEach((v, k) => { headers[k] = v; });
			results.responseHeaders = headers;
		}

		results.ok = results.steps.every(s => s.ok);
		res.json(results);
	} catch (err) {
		results.steps.push({ step: 'exception', ok: false, error: err.message });
		res.status(500).json({ ok: false, results, error: err.message });
	}
});

// Fetch full playlist tracks (paginated) and normalize to local track shape
async function fetchSpotifyPlaylistTracksFull(playlistId){
	const token = await getSpotifyAccessToken();
	// Use the playlist object with fields to fetch tracks and paging reliably
	const fields = 'tracks.items(track(id,uri,name,artists(name),album(images))),tracks.next';
	let url = `https://api.spotify.com/v1/playlists/${playlistId}?fields=${encodeURIComponent(fields)}`;
	const out = [];
	while (url) {
		const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
		const txt = await r.text(); let data;
		try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { raw: txt }; }
		if (!r.ok) {
			// extra diagnostics for 403/401 — identify token owner and playlist owner
			let me = null; let pl = null;
			try { const m = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token}` } }); me = m.ok ? await m.json() : null; } catch (e) { }
			try { const p = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, { headers: { Authorization: `Bearer ${token}` } }); pl = p.ok ? await p.json() : null; } catch (e) { }
			const meId = me && me.id ? me.id : '<unknown>';
			const ownerId = pl && pl.owner && pl.owner.id ? pl.owner.id : '<unknown>';
			const msg = `Failed to fetch playlist tracks: ${r.status} ${r.statusText} - tokenUser=${meId} playlistOwner=${ownerId} body=${JSON.stringify(data)}`;
			throw new Error(msg);
		}
		const trackBlock = data.tracks || {};
		const items = trackBlock.items || [];
		for (const it of items) {
			const tr = it && it.track;
			if (!tr || !tr.id) continue;
			out.push({ id: tr.id, uri: tr.uri, title: tr.name, artists: (tr.artists || []).map(a => a.name).join(', '), albumImage: (tr.album && tr.album.images && tr.album.images[0]) ? tr.album.images[0].url : null });
		}
		// next may be in tracks.next
		url = trackBlock.next || null;
	}
	return out;
}

// Admin: get sync status between Spotify playlists and Redis lists/sets
app.get('/api/admin/sync_status', verifyAdmin, async (req, res) => {
	try{
		const report = {};
		if (PLAYLIST_REQUESTS) {
			const spReq = await fetchSpotifyPlaylistTracksFull(PLAYLIST_REQUESTS);
			const redisReqRaw = await redis.lRange(REDIS_REQ_KEY, 0, -1);
			const redisReq = redisReqRaw.map(r=>{ try{ return JSON.parse(r).track }catch(e){return null} }).filter(Boolean).map(t=>t.id);
			report.requests = { spotifyCount: spReq.length, spotifyIds: spReq.map(t=>t.id), redisCount: redisReq.length, redisIds: redisReq };
		}
		if (PLAYLIST_LIVE) {
			const spLive = await fetchSpotifyPlaylistTracksFull(PLAYLIST_LIVE);
			const redisLiveRaw = await redis.lRange(REDIS_LIVE_KEY, 0, -1);
			const redisLive = redisLiveRaw.map(r=>{ try{ return JSON.parse(r).track }catch(e){return null} }).filter(Boolean).map(t=>t.id);
			report.live = { spotifyCount: spLive.length, spotifyIds: spLive.map(t=>t.id), redisCount: redisLive.length, redisIds: redisLive };
		}
		return res.json({ ok: true, report });
	}catch(e){ console.error('sync_status failed', e); return res.status(500).json({ ok: false, error: e.message }); }
});

// Admin: sync Spotify -> Redis (safe default). This replaces Redis lists/sets to match Spotify playlist contents.
app.post('/api/admin/sync_playlists', verifyAdmin, express.json(), async (req, res) => {
	try{
		const direction = (req.body && req.body.direction) || 'spotify->redis';
		if (direction !== 'spotify->redis') return res.status(400).json({ ok: false, error: 'Only spotify->redis sync supported for safety' });
		const result = { requests: null, live: null };
		if (PLAYLIST_REQUESTS) {
			const spReq = await fetchSpotifyPlaylistTracksFull(PLAYLIST_REQUESTS);
			// replace Redis requests list and set
			await redis.del(REDIS_REQ_KEY);
			await redis.del(REDIS_REQ_SET);
			if (spReq.length>0){
				const pushItems = spReq.map(t => JSON.stringify({ addedAt: Date.now(), track: t }));
				// push in order
				for (const p of pushItems) await redis.rPush(REDIS_REQ_KEY, p);
				for (const t of spReq) await redis.sAdd(REDIS_REQ_SET, t.id);
			}
			result.requests = { syncedCount: spReq.length };
		}
		if (PLAYLIST_LIVE) {
			const spLive = await fetchSpotifyPlaylistTracksFull(PLAYLIST_LIVE);
			await redis.del(REDIS_LIVE_KEY);
			await redis.del(REDIS_LIVE_SET);
			if (spLive.length>0){
				const pushItems = spLive.map(t => JSON.stringify({ addedAt: Date.now(), track: t }));
				for (const p of pushItems) await redis.rPush(REDIS_LIVE_KEY, p);
				for (const t of spLive) await redis.sAdd(REDIS_LIVE_SET, t.id);
			}
			result.live = { syncedCount: spLive.length };
		}
		// emit updates
		io.emit('requests_update', await getRequests());
		io.emit('live_update', await getLive());
		return res.json({ ok: true, result });
	}catch(e){ console.error('sync_playlists failed', e); return res.status(500).json({ ok: false, error: e.message }); }
});

// wildcard 404 handler (serve styled 404 page)
app.use((req, res) => {
	res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
});

server.listen(PORT, () => console.log(`Server listening on ${PORT}`));

