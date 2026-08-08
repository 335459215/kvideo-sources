# KVideo 视频源聚合(自动巡检版)

KVideo 数据源订阅 + **GitHub Actions 每日自动巡检**。

## 三个文件的分工

| 文件 | 作用 | 谁改它 |
| :--- | :--- | :--- |
| [`master.json`](./master.json) | **总源池**:所有已知源,永不丢失 | 只手动改(加源/手动禁用) |
| [`sources.json`](./sources.json) | **订阅文本**:只含巡检验证有效的源 | 巡检自动重写 |
| [`disabled.json`](./disabled.json) | 失效归档:无效源 + 原因(仅供参考) | 巡检自动重写 |

**流程**:每天定时(01:00 CST)巡检**只读 master.json** → 对每个源做 `ac=list` 存活测试 → **有效的写入 sources.json(订阅),无效的不放进去**,但 master.json 原封不动。失效源每天复测,恢复后自动回到订阅。

> 用 `ac=list` 而非搜索片名:任何有内容的站(含成人站)都能通过,不会误杀。

## 订阅地址

```
https://raw.githubusercontent.com/335459215/kvideo-sources/main/sources.json
```

在 KVideo 设置 → 订阅管理中加为订阅(或设置 `SUBSCRIPTION_SOURCES` 环境变量),所有用户自动同步。

## 维护说明

- **加源**:编辑 `master.json` 加一条 `{id, name, baseUrl, searchPath, detailPath, group}` → push → 自动触发巡检验证,有效自动进订阅
- **手动停用**:master.json 里给该源加 `"_comment": "手动禁用"` → 巡检不再放它进订阅
- **格式要求**:苹果CMS JSON 接口(`api.php/provide/vod` 类),响应 `{code:1, list:[...]}`;`/at/xml` 结尾去后缀即同站 JSON 版;海洋CMS(`inc/api.php`/`mc10/vod/xml` 等)KVideo 不支持
- **手动运行**:`node check_sources.js`,或仓库 Actions 页手动触发"源健康巡检"
