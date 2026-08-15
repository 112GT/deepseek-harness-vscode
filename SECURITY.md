# Security policy

## API keys and private data

- Never add an API key, token, password, cookie, .env file, VS Code SecretStorage data, chat history, or node_modules directory to Git.
- The extension stores the DeepSeek API key in VS Code SecretStorage and only passes it to its owned local Harness process.
- Before creating a commit or GitHub Release, run the repository secret scan and inspect the staged file list.

If an API key is exposed, revoke it immediately in the provider console, remove it from Git history before publishing, and create a replacement key.

## Reporting a vulnerability

Do not publish security vulnerabilities or exposed credentials in a public issue. Contact the repository owner privately with affected versions, reproduction steps, and the potential impact.

