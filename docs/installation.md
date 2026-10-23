# Installation Guide

SillyAgent is a community-maintained fork of SillyTavern with its agent harness integrated into the server and core conversation flow. Install this repository, not the upstream SillyTavern repository, to get the SillyAgent features described here. Use the `main` branch.

## Requirements

- **Node.js 24 LTS (recommended for every platform)**, including npm. Download it from the [official Node.js website](https://nodejs.org/en/download). Choose the **24.x LTS** release, not the **Current** release.
- Node.js **22.5 or newer** is the technical minimum for SillyAgent's SQLite-backed memory, roleplay state, and background reflection. Node.js 20 may start the underlying SillyTavern app, but does not support these core SillyAgent features and is not a supported setup for the full experience.
- Git.
- An internet connection for the initial clone and dependency installation.
- Free disk space for the repository, dependencies, chat data, and backups.
- An LLM provider configured in SillyTavern. SillyAgent does not include a model; local inference is optional and depends on the provider you connect.

**Before cloning, install Git and Node.js 24 LTS.** Then open a new terminal and verify that the versions are available:

```sh
node --version
npm --version
git --version
```

The Node version should start with `v24.`. If it reports `v20.`, `v22.0`–`v22.4`, or `node: command not found`, fix the Node installation/PATH before continuing.

Official download links: [Node.js 24 LTS](https://nodejs.org/en/download) · [Git](https://git-scm.com/downloads)

## Linux

1. Install Git and Node.js 24 LTS. On Linux, use the official Node.js download instructions or a Node version manager, and make sure the selected version is 24.x. Some distribution repositories provide an older Node version.
2. Open a terminal and run:

   ```sh
   git clone --single-branch --branch main https://github.com/Bulldogshot10/SillyAgent.git
   cd SillyAgent
   bash start.sh
   ```

The startup script installs the production dependencies and starts the server. Keep the terminal open and visit the local URL printed by the server, usually `http://127.0.0.1:8000`.

## macOS

1. Install Git (if it is not already available) and the **Node.js 24 LTS macOS installer** from the [official download page](https://nodejs.org/en/download).
2. Open a new Terminal window and verify `node --version` shows `v24.`.
3. Clone and start SillyAgent:

   ```sh
   git clone --single-branch --branch main https://github.com/Bulldogshot10/SillyAgent.git
   cd SillyAgent
   bash start.sh
   ```

Keep Terminal open while the server runs. Open the local URL printed during startup, usually `http://127.0.0.1:8000`.

## Windows

1. Install [Git for Windows](https://git-scm.com/download/win).
2. Install **Node.js 24 LTS for Windows** from the [official Node.js download page](https://nodejs.org/en/download). Choose the 24.x **LTS** Windows installer, not the Current release.
3. Close and reopen PowerShell. Confirm `node --version` shows `v24.`, then clone the repository:

   ```powershell
   git clone --single-branch --branch main https://github.com/Bulldogshot10/SillyAgent.git
   cd SillyAgent
   ```

4. Start the app with:

   ```powershell
   .\Start.bat
   ```

Keep the terminal window open while SillyAgent runs. Open the local URL printed during startup, usually `http://127.0.0.1:8000`. If PowerShell cannot find `node` or `npm`, reinstall Node.js 24 LTS or fix PATH, then reopen the terminal.

## Android using Termux

This installs the server inside Termux; it is **not an APK**. Install Termux from [F-Droid](https://f-droid.org/packages/com.termux/) or the [official GitHub releases](https://github.com/termux/termux-app/releases). Avoid the old Google Play build, which is not maintained.

### 1. Update Termux

Open Termux and select a working package mirror if needed:

```sh
termux-change-repo
pkg update && pkg upgrade
```

### 2. Install Git and Node.js LTS

```sh
pkg install git nodejs-lts
```

Now verify the installed runtime **before cloning**:

```sh
node --version
npm --version
git --version
```

The Node version must be at least **22.5.0**; Node.js 24 LTS is the recommended major version. The `nodejs-lts` package in Termux tracks an LTS release. If your installed version is below 22.5.0, update your Termux packages and check again rather than continuing with a runtime that lacks SillyAgent's SQLite features.

If Termux says `node` or `npm` cannot be found, check that package installation completed successfully and reopen the Termux session.

### 3. Clone SillyAgent

Keep the repository inside Termux's private home directory instead of shared Android storage:

```sh
cd ~
git clone --single-branch --branch main https://github.com/Bulldogshot10/SillyAgent.git
cd SillyAgent
```

### 4. Start SillyAgent

```sh
bash start.sh
```

The startup script installs production dependencies and launches the server. The first launch needs an internet connection and may take a while while packages download. Keep Termux open, then open the local address printed in the terminal in your Android browser, usually `http://127.0.0.1:8000`. Press `CTRL+C` in Termux to stop the server.

For the specific dependency error mentioning `android arm LEtime-web` on 32-bit Android, try:

```sh
pkg install esbuild
```

### 5. Termux tips

Android can suspend background apps to save battery. For a long-running server, use Termux's documented wake-lock support and adjust Android battery restrictions for Termux. Do not move the repository into shared storage; that can cause executable-permission and symlink problems.

## First launch and model setup

SillyAgent starts the SillyTavern web application. It does not ship with an LLM. Open the local URL printed in the terminal, then select and configure a provider/model in SillyTavern's existing settings. You can use a hosted API or a local inference server supported by SillyTavern.

The first launch installs production dependencies automatically. Run `bash start.sh` on Linux/macOS/Termux or `Start.bat` on Windows from the repository folder. Leave that terminal open while using the app.

## Updating

Back up your SillyTavern user data before updating. From the repository directory, check for local changes and fast-forward to the latest `main`:

```sh
git status
git fetch origin
git pull --ff-only origin main
bash start.sh
```

On Windows, start again with `Start.bat`. If `git status` shows local source changes you need to keep, commit or back them up before pulling. The `main` branch is under active development and behavior may change.

Do not replace the updated repository's entire `public` directory with an old copy. Back up the SillyTavern data directory and restore only the user data you need.

## Configuring background reflection

Message capture and the model's tool-calling path do not require a trigger word. Background memory reflection requires an explicitly configured provider and must be enabled.

### Configure it in the WebUI

Open the **SillyAgent Agent Core** drawer using the brain icon, then find **Background reflection and self-improvement**.

1. Enter the provider's full OpenAI-compatible chat-completions URL, such as `https://api.openai.com/v1/chat/completions` or a compatible local endpoint.
2. Enter the exact model ID accepted by that endpoint.
3. Choose the matching credential slot in **Credential stored in SillyTavern Secrets**. First add and activate that API key in SillyTavern's Secrets manager. The dropdown chooses a secret key identifier; it does not contain the API key itself. Select **No authentication** for endpoints that genuinely do not require a key.
4. Press **Test connection**. SillyAgent sends one short chat-completions request using the current draft values and displays either the provider's reply or its error. Testing does not save the draft or enable the worker.
5. Press **Save background worker settings** to persist the configuration. Select **Enable autonomous background reflection** before saving if you want the server worker to process queued jobs.

The provider settings status also reports whether the endpoint/model are configured and whether the selected credential has an active secret. A successful connection test alone does not enable reflection: save the settings with the enable checkbox selected.

Use the endpoint's actual OpenAI-compatible `/chat/completions` path and the model identifier expected by that provider. Non-loopback endpoints must use HTTPS; plain HTTP is accepted only for localhost/loopback services. Do not paste raw API keys into the reflection settings file.

### Configuration file and API

For headless setups, the settings are stored under the active SillyTavern data root at:

```text
sillyagent/reflection-provider.json
```

The native endpoints are `/api/agent/tools/memory/reflection-provider` (read), `POST /api/agent/tools/memory/reflection-provider` (save), and `POST /api/agent/tools/memory/reflection-provider/test` (test a draft without saving).

A configuration file has this shape:

```json
{
  "enabled": true,
  "endpoint": "https://provider.example/v1/chat/completions",
  "model": "your-model-id",
  "secretKey": "api_key_openai"
}
```

`secretKey` points to a credential already stored in SillyTavern's secret manager; it is a key identifier, not the secret itself. The default configuration is disabled until configured. After enabling the provider, the backend reflection worker processes queued jobs automatically. It does not require a chat command or a special trigger phrase. See the [architecture guide](sillyagent-architecture.md) for the full flow.

## Troubleshooting

- **`node: command not found` or `npm: command not found`:** install Node.js 24 LTS, reopen the terminal, and verify `node --version` and `npm --version`.
- **Node.js is version 20 or below 22.5:** upgrade to Node.js 24 LTS. SillyAgent's SQLite-backed memory, roleplay state, and background reflection require Node.js 22.5 or newer.
- **The browser cannot connect:** use the exact local URL printed by the server, check that the terminal process is still running, and confirm the configured port has not changed.
- **Dependency download fails:** check the internet connection and retry startup. On Termux, run `termux-change-repo` and `pkg update` if package mirror downloads fail.
- **Termux reports a native dependency/platform error:** update Termux and its packages. For the specific `android arm LEtime-web` error on 32-bit Android, try `pkg install esbuild`.
- **Storage is low:** free space and retry. The repository, dependencies, chat history, and backups all consume storage.

## Network and data notes

By default, run the app for local use and use the local address printed by the server. If you deliberately expose it to a LAN or the internet, configure authentication and network access deliberately first; do not publish an unauthenticated server directly to the public internet.

SillyAgent stores memory, state, provider settings, and SillyTavern conversation data under the configured user data root. Treat that directory as private and include it in your backup plan. When you enable a remote reflection provider, bounded conversation context is sent to that provider for processing.
