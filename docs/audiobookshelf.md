# Audiobookshelf integration

EchoLink can inspect and normalize Audiobookshelf book metadata without filesystem access.

## Configuration

Set these values in `/root/echolink/.env` and restart EchoLink:

```env
AUDIOBOOKSHELF_URL=https://your-audiobookshelf.example
AUDIOBOOKSHELF_API_KEY=your-api-key
AUDIOBOOKSHELF_TIMEOUT_MS=15000
```

Use a dedicated Audiobookshelf user/API key with only the libraries and update permissions that EchoLink actually needs. The key never goes to the model; EchoLink's server-side adapter adds the Bearer header.

## Local adapter

The adapter is mounted at `/api/audiobookshelf`. Browser requests may use the normal EchoLink session. Internal terminal calls use `X-Echo-Api-Key: $ECHO_API_KEY` and stay on `127.0.0.1:3000`.

Available operations:

- `GET /status`
- `GET /libraries`
- `GET /libraries/:libraryId/items?limit=50&page=0`
- `GET /items/:itemId`
- `POST /apply`

`POST /apply` accepts at most 25 book updates. Only metadata fields are accepted; file operations, covers, chapters and audio-file mutations are impossible through this route. Every update must include the `expectedUpdatedAt` value from the preview read. EchoLink preflights all items before writing and returns HTTP 409 if any item changed in the meantime.

The `audiobookshelf` skill instructs the model to show an old/new preview and wait for explicit user confirmation before issuing the write request. The existing terminal approval layer provides a second confirmation for the POST.
