# MaSu Peer 👑

Royal P2P Messenger — WebRTC + Firebase. No build step required.

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell — loads everything |
| `style.css` | All styles (royal purple/gold theme) |
| `app.js` | All React components + Firebase + WebRTC logic |
| `sw.js` | Service worker (PWA offline support) |
| `manifest.json` | PWA manifest |
| `firebase.json` | Hosting + rules config |
| `firestore.rules` | Firestore security rules |
| `firestore.indexes.json` | Required composite indexes |
| `database.rules.json` | Realtime Database security rules |

## Deploy in 3 steps

```bash
# 1. Install Firebase CLI (once)
npm install -g firebase-tools && firebase login

# 2. Link to your project
firebase use messenger-chat-public

# 3. Deploy everything
firebase deploy
```

Live at: **https://messenger-chat-public.web.app**

## First-time Firebase setup

Run these once before deploying:

```bash
# Deploy security rules + indexes
firebase deploy --only firestore:rules,firestore:indexes,database
```

Then in Firebase Console:
- **Authentication** → Enable **Google** provider
- **Firestore** → Create in Native mode
- **Realtime Database** → Create database

## Features

### Core
- ✅ Google Sign-In only (no email/password)
- ✅ Unique 8-character ID per user (e.g. `AB3C4D5E`) — share to find friends
- ✅ Search users by name OR by their unique ID
- ✅ Friend request system — works whether receiver is online or offline
- ✅ Only accepted friends can chat/call

### Messaging
- ✅ P2P via WebRTC DataChannel (direct browser-to-browser)
- ✅ Firebase Firestore fallback (persistent, always works)
- ✅ Reply, edit, delete, forward messages
- ✅ Emoji reactions (👍 ❤️ 😂 😮 😢 🔥 🎉 ✅)
- ✅ Read receipts (single ✓ sent, double ✓✓ read)
- ✅ Typing indicators
- ✅ Online/offline presence
- ✅ Message pagination (30 per page, scroll up for older)
- ✅ In-chat message search with prev/next navigation
- ✅ Offline drafts via IndexedDB

### Calls
- ✅ Voice calls (audio only)
- ✅ Video calls (camera + mic)
- ✅ Screen sharing
- ✅ Picture-in-picture local video
- ✅ Mute / camera toggle
- ✅ Call duration timer

### Files
- ✅ File & image sharing (up to 100 MB)
- ✅ Chunked transfer via DataChannel (16KB–256KB adaptive chunks)
- ✅ SHA-256 integrity check on every received file
- ✅ Transfer progress bar with speed and ETA
- ✅ Auto-download on receive

### UI
- ✅ Royal purple/gold theme
- ✅ Notification bell with unread counts + friend request badge
- ✅ Slide-in menu (Home / Requests / Settings)
- ✅ P2P connection type badge (🔗 STUN Direct / ↗ TURN Relay / ☁ Firebase)
- ✅ PWA — installable on iOS and Android
- ✅ Profile photo (change from Settings, stored as base64 in Firestore)

## How Friend Requests Work

1. Search for a user by name or their 8-char ID
2. Tap **+** to send request → writes to Firestore `friendRequests` collection
3. Receiver gets notified instantly if online, or on next app open if offline
4. Accept → both users added to each other's friends list, chat created
5. Only then can they message, call, or share files

> **This works offline because Firestore is persistent storage.**
> The `onSnapshot` listener fires when the receiver opens the app,
> even if they were offline when the request was sent.

## Architecture

```
Firestore (persistent)
  users/{uid}                 — profile, shortId, photoURL
  users/{uid}/friends/{fid}   — accepted friends
  friendRequests/{id}         — all friend requests (pending/accepted/declined)
  chats/{chatId}              — chat metadata
  chats/{chatId}/messages     — all messages

Realtime Database (ephemeral)
  presence/{uid}              — online/offline/lastSeen
  typing/{chatId}/{uid}       — typing indicator
  signaling/{uid}/...         — WebRTC ICE/SDP exchange
  calls/{uid}/...             — call offer/answer/end
  unread/{uid}/{chatId}       — unread message counter

WebRTC (direct P2P)
  DataChannel                 — messages + file chunks
  MediaChannel                — audio/video for calls
  STUN                        — ICE negotiation only (no data)
  TURN                        — last-resort relay if direct blocked
```

## Troubleshooting

**Friend requests not showing?**
→ Deploy Firestore rules: `firebase deploy --only firestore:rules`
→ The `friendRequests` query needs the composite index in `firestore.indexes.json`
→ Run: `firebase deploy --only firestore:indexes`

**P2P not connecting?**
→ Normal on some networks. App automatically falls back to Firebase.
→ TURN servers activate automatically when STUN fails.

**Profile photo not saving?**
→ Compressed to 160×160 JPEG (~8KB). Firestore limit is 1MB per doc — well within range.
