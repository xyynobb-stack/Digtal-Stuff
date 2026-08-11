---
name: python-web-reader
description: 当无法使用 Git Bash 或 curl 工具时，优先借助 Python 获取网页文本并完成内容摘要整理。
version: 1.0.0
author: DigitalStuff
license: Internal
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [web, python, windows]
---

# Python Web Reader

Use this skill when the user asks what a web page says and a direct browser workflow is not required.

## Rules

1. Prefer the installed Python runtime before trying Git Bash, `curl`, or `wget`.
2. Fetch only the URL the user provided. Use a short timeout and set a normal User-Agent header.
3. Extract readable text, then summarize it in Chinese unless the user asks for another language.
4. If the page requires JavaScript, sign-in, CAPTCHA, or returns an error, explain that limitation and use the browser tool only when available.
5. Never submit forms, download executables, or send credentials without the user's explicit instruction.

## Minimal Python pattern

```python
from html import unescape
from html.parser import HTMLParser
from urllib.request import Request, urlopen

url = "https://example.com"
request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
with urlopen(request, timeout=15) as response:
    html = response.read().decode("utf-8", errors="replace")

class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
    def handle_data(self, data):
        self.parts.append(data)

parser = TextExtractor()
parser.feed(html)
text = " ".join(" ".join(parser.parts).split())
print(unescape(text[:12000]))
```

## Expected response

State the page title or source when available, provide a concise summary, and call out anything that could not be retrieved.
