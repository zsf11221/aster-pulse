# reference/ — 只作阅读参考，运行时不读这些文件

- `client.js`、`backend.js`：原站 `worker/index.js` 里前后端逻辑的拆分版，方便看懂代码。
- `README-部署说明-原包.md`、`SHA256SUMS.txt`：2026-11-07 导出的原始源码包自带的说明和校验值。

**改网站请改仓库根目录下的 `app/worker.js`，不要改这里。**
改这里不会生效，服务器跑的是 `app/worker.js` + `server.js`。
