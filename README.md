# fisheraiagent

Open-source AI agent tools by [AgentFleet](https://agentfleet.team/). Self-host them for free, or use them through AgentFleet.

> Status: design. Nothing here is ready to run yet. Follow the issues for progress.

## Tools

| Tool | What it does | Status |
|---|---|---|
| YouTube transcript | One YouTube URL in, the full timed transcript out. Works for videos with or without captions. Use it from a web page, a Discord bot, or the command line. | design |

## How the YouTube transcript tool will work

```text
 Web page (one box)     Discord bot (paste a URL)     CLI / any AI agent
          \                     |                         /
           +--------> one service (self-host or hosted) <-+
                         |
                         | your own Gemini API key (BYOK)
                         v
               Gemini reads the public YouTube URL
                         |
                         v
     transcript back to where you asked  +  saved where you chose
     (same page / same Discord thread)      (Google Drive, NAS, or nowhere)
```

- **Bring your own key.** Each user or Discord server sets their own Gemini API key. On the web, the key stays in your browser.
- **Your destination, your config.** Each user or Discord channel chooses where transcripts are saved. Adding a user is configuration, not code.
- **One program.** The same container runs on your own machine (`docker compose up`) or on our hosted instance.

## Limits (from Google)

Gemini reads public or unlisted YouTube videos only, one video per request. See [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

---

**中文簡介**：AgentFleet 開源的 AI agent 工具。第一個工具：貼上 YouTube 網址，拿回完整逐字稿（有沒有字幕都可以）；可從網頁、Discord bot 或指令列使用，每位使用者用自己的 Gemini key、自己決定存放位置。可免費自架，也可使用 AgentFleet 代管服務。
