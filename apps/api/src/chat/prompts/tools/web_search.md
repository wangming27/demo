# web_search

## description

请求你选择的搜索结果页 URL，解析最多 10 条候选标题、URL 和摘要，不读取正文。自行选择搜索引擎、关键词和搜索参数，传入完整 URL；服务端不会添加或改写查询参数。支持 Bing、Google、百度和 DuckDuckGo 的常见 HTML 搜索结果页；无法解析时更换搜索 URL 或用 web_fetch 读取页面。

## url

完整的 HTTP/HTTPS 搜索结果页 URL，最长 2048 字符。将简短关键词和必要的语言、市场、站点限定等参数放入 URL，查询词只编码一次。不能只传关键词或搜索引擎首页；不允许内网地址。
