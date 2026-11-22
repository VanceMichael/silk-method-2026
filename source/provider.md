# 实验室原件和买家回领

`GET /labpacks/manifest?id=包号` 返回清单代、各成员的 `path`、`sha256`、指标和页范围。同一页名可能复用，文件按清单摘要核实。演练页为带 UTF-8 BOM 的 CSV，第一行为中文列名，按 CSV 规则处理引用内逗号。此源的厘牛换算为 0.01 牛。
`GET /buyers/receipts` 返回当前买家回领。 `POST /buyers/withdraw` 接 `order`、`item`、`receipt`。状态 `pending` 是已申请，`withdrawn` 表示该买家确认停用。 `POST /buyers/deliver` 接相同订单、指标、`manifest` 和成员校验值，可收到 409 旧件尚未停用。
现场有旧包 `draft`、改签 `corrected` 和买家确认之后 `withdrawn` 三档。原有检验与买家方法资料仍由首个服务给出。
