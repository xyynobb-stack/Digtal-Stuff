<!-- AGENT_WINDOWS_PYTHON_RULES -->

## Windows 工具使用规则

此版本未内置 Git Bash、curl 或 wget。

遇到读取公开网页、调用 HTTP 接口、下载公开文本等任务时，优先使用已内置的 Python 3 和标准库 `urllib.request` 实现。不要仅因缺少 Git Bash、curl 或 wget 就判定任务无法完成。

仅当网页必须进行 JavaScript 交互、需要登录，或 Python 请求失败时，再使用浏览器工具或其他可用工具。
