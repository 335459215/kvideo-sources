# KVideo 视频源聚合(自动巡检版)

KVideo 数据源订阅文件,每天 **GitHub Actions 自动巡检**:
- 对每个源执行 `ac=list` 存活测试(任何有内容的站都能通过,避免成人站搜片名被误杀)
- ✅ **生效的源**写入 [`sources.json`](./sources.json)(即订阅文件本身)
- ❌ **失效的源移出**到 [`disabled.json`](./disabled.json) 归档,每天复测,恢复后自动回到订阅
- 状态与历史趋势见 [`report.md`](./report.md)

## 订阅地址

```
https://raw.githubusercontent.com/335459215/kvideo-sources/main/sources.json
```

在 KVideo 设置 → 订阅管理中把该地址加为订阅(或设置 `SUBSCRIPTION_SOURCES` 环境变量),所有用户自动同步。

## 手动运行巡检

```bash
node check_sources.js
```

或到仓库 Actions 页手动触发 **源健康巡检** 工作流。

## 维护说明

- 想加源:直接编辑 `sources.json`(或用 `disabled.json` 里归档的),push 后自动触发巡检验证
- 想强制停用某源:把它从 `sources.json` 移到 `disabled.json` 并加 `"_comment": "手动禁用"`(自动巡检不会再启用它)
- 格式要求:苹果CMS JSON 接口(`api.php/provide/vod` 类),响应 `{code:1, list:[...]}`;`/at/xml` 结尾的接口去掉后缀即 JSON 版;海洋CMS 等格式 KVideo 不支持
