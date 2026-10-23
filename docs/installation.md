# Installation Guide

SillyAgent is distributed as a modified SillyTavern repository. Clone this repository's `main` branch to get the integrated core changes. Cloning upstream SillyTavern directly will not include the SillyAgent changes documented here.

## Requirements

- Git.
- Node.js 20 or newer, with npm.
- Enough free storage for the application, Node dependencies, chat history, and model/provider caches.
- An LLM API/provider configured in SillyTavern. Local inference is optional and depends on the provider you use.

Check your runtime:

```sh
node --version
npm --version
git --version
```

## Linux and macOS

```sh
git clone --single-branch --branch main https://github.com/Bulldogshot10/SillyAgent.git
cd SillyAgent
bash start.sh
```

The startup script installs the production Node dependencies and launches the server. After startup, open the local address printed in the terminal. SillyTavern commonly uses `http://127.0.0.1:8000` by default.

If you prefer to manage dependencies manually, run `npm install --no-audit --no-fund` once and then use `npm start`.

## Windows

Install Git and Node.js 20 or newer, then clone the `main` branch:

```powershell
git clone --single-branch --branch main https://github.com/Bulldogshot10/SillyAgent.git
cd SillyAgent
```

Run `Start.bat` from the repository folder. If you manage the Node environment yourself, run `npm install --no-audit --no-fund` followed by `npm start`.

## Android using Termux

This is a native Termux installation, not an APK. Install Termux from [F-Droid](https://f-droid.org/packages/com.termux/) or the [official GitHub releases](https://github.com/termux/termux-app/releases). The old Google Play build is not maintained.

### 1. Update Termux and select a mirror

Open Termux and run:

```sh
termux-change-repo
```

Choose a working mirror if prompted, then update the package index and installed packages:

```sh
pkg update && pkg upgrade
```

### 2. Install Git and Node.js

```sh
pkg install git nodejs-lts nano
node --version
npm --version
```

The Node.js version must be 20 or newer. If Termux says Node or npm cannot be found, finish package installation and reopen the shell before continuing.

On 32-bit Android only, if npm reports an unsupported `android arm LEtime-web` platform dependency, install the Termux package noted by the upstream Android guide:

```sh
pkg install esbuild
```

### 3. Clone SillyAgent

```sh
cd ~
git clone --single-branch --branch main https://github.com/Bulldogshot10/SillyAgent.git
cd SillyAgent
```

### 4. Start the server

```sh
bash start.sh
```

The startup script installs production dependencies and starts SillyTavern. Keep Termux open while the server is running, then open the local address shown in the terminal in your Android browser, usually `http://127.0.0.1:8000`. Press `CTRL+C` in Termux to stop the server.

For a manual dependency install, you can instead run:

```sh
npm install --no-audit --no-fund
npm start
```

### 5. Optional Termux quality-of-life steps

Use `nano` to edit configuration files. Android may pause background apps to save battery; use Termux's documented wake-lock support when you need a long-running server. Avoid moving the repository into shared Android storage: keeping it inside Termux's home directory avoids many executable-permission and symlink problems.

### Termux troubleshooting

- **Mirror or package downloads fail:** rerun `termux-change-repo`, select a reachable mirror, then run `pkg update`.
- **Wrong Node.js version:** run `pkg upgrade nodejs-lts` and check `node --version` again.
- **Native dependency build/platform error:** make sure you're using the current Termux app and packages. On 32-bit Android, try `pkg install esbuild` for the specific `android arm LEtime-web` error.
- **Server starts, but the browser cannot connect:** use the exact local URL printed by the server. Check that Termux is still running and that the port has not been changed in configuration.
- **Install fails because storage is low:** free storage and retry. The application, dependencies, chat data, and backups all need space.

## Updating

Before updating, back up your user data and make sure any local source changes are committed or stashed. From the repository folder:

```sh
git status
git fetch origin
git pull --ff-only origin main
bash start.sh
```

The `main` branch is under active development and may change frequently. Avoid copying an entire old `public` directory over the updated repository. Back up the SillyTavern data directory and restore only the user data you actually need.

## Configuring background reflection

Message capture and the model's tool-calling path do not require a trigger word. Background memory reflection does require a configured provider and must be enabled.

The reflection provider configuration is stored under the active SillyTavern data root at:

```text
sillyagent/reflection-provider.json
```

The settings are also exposed through the native endpoint `/api/agent/tools/memory/reflection-provider`. A configuration has this shape:

```json
{
  "enabled": true,
  "endpoint": "https://provider.example/v1/chat/completions",
  "model": "your-model-id",
  "secretKey": "api_key_openai"
}
```

Use your provider's actual OpenAI-compatible chat-completions endpoint and model identifier. `secretKey` points to a credential already stored in SillyTavern's secret manager; it is a key identifier, not the secret itself. Do not paste API keys into this JSON file. The default configuration is disabled until configured. HTTPS is required for non-loopback endpoints; plain HTTP is accepted only for localhost/loopback services.

After enabling the provider, the backend reflection worker processes queued jobs automatically. It does not require a chat command or a special trigger phrase. See the [architecture guide](sillyagent-architecture.md) for the full flow.

## Network and data notes

By default, start the app for local use and use the local address printed by the server. If you deliberately expose it to a LAN or the internet, configure authentication and network access deliberately first; do not publish an unauthenticated server directly to the public internet.

SillyAgent stores memory, state, provider settings, and SillyTavern conversation data under the configured user data root. Treat that directory as private and include it in your backup plan. When you enable a remote reflection provider, bounded conversation context is sent to that provider for processing.
