# Deuteron Wallet

Deuteron wallet是一款专门为AI Agent设计的Web3钱包。Deuteron wallet掘弃了常见Web3钱包的GUI，完全使用cli进行控制。这大大降低了Agent调用钱包的门槛，因为Agent本身更适合调用命令行，而不是使用人类友好的GUI。

## 架构设计

Deuteron采用双层架构：deuteron-agent与deuteron。其中，deuteron-agent为后台守护进程（daemon）——这相当于服务端，专门处理需要与私钥交互的钱包操作；deuteron为cli应用——这相当于客户端，用于用户交互，处理一些不需要与私钥交互的操作（如查询链上信息等）。如果用户发起需要私钥的操作，就向deuteron-agent发送请求。

### deuteron-agent

deuteron-agent是一个由Rust编写的二进制文件。该独立二进制文件在 macOS 下拥有明确的代码签名（Code Signing）标识，这让 Keychain 的 ACL（访问控制列表）能够精准锁定“只有 Rust 守护进程可以访问该密钥项”。

助记词或私钥被存储在macOS独有的Keychain里，只有deuteron-agent能够有权访问。当首次授权给deuteron-agent访问Keychain里助记词或私钥权限之后，除非需要明文导出助记词，否则都可以通过agent完成签名，无需用户每次手动授权。

### deuteron cli

deuteron cli采用ts/js语言编写，因为可能需要接入很多诸如Jupiter、Phantom、Web3.js、Solana钱包SDK等组件，这些很多都是用ts/js写的，因此选择Ts/Js会有较好的兼容性。

cli负责用户（AI Agent）与钱包交互，并且负责不需要私钥或助记词就可以完成的各种操作，比如查询链上信息、查询当前钱包余额等操作。整体来讲，这个cli是一个经典的“即用即走型”应用。

cli是唯一可以与deuteron-agent交互的方式。

### deuteron-agent与cli的通信

当AI Agent调用需要签名的cli命令的时候（比如deu send或deu swap等），会调用Unix Domain Socket与deuteron-agent通信，deuteron-agent将签名结果返回。

## 具体功能与实现思路指引

首先，钱包具备钱包创建、导入与管理功能。底层可采用okx钱包sdk搭建：https://github.com/okx/js-wallet-sdk

### CLI 设计约束

为了让该CLI既适合人类使用，也适合AI Agent和脚本稳定调用，命令层需要遵循以下约束：

1. 所有命令都应支持 `--json`，用于输出稳定的机器可读结果；默认输出可以是更适合人类阅读的文本。
2. 所有错误信息都应输出到 stderr，并使用非 0 退出码。
3. 助记词与私钥不得直接通过命令行参数明文传入，否则会泄露到 shell history、进程列表与日志中。
4. 涉及助记词或私钥输入的命令，应使用 stdin、文件输入或安全交互式输入。
5. `wallet switch` 写入的是全局上下文，因此必须提供对应的 `wallet current` 读取能力。
6. `--json` 输出应采用稳定结构，例如 `{"ok": true|false, "code": "...", "data": {...}, "error": {...}}`，避免脚本依赖自然语言文本解析。

cli分为5类：
- 无需访问敏感资料，标记为[0]
- 需要访问敏感资料，但不暴露敏感资料，此时无需每次都授权，只需最开始授权一次给deuteron-agent即可，标记为[1]
- 需要访问敏感资料，且暴露敏感资料，且需要每次都授权，标记为[2]
- 会新增、写入或变更敏感资料，且需要每次都显式确认，标记为[3]
- 销毁敏感资料，需要每次都授权，标记为[4]

可用命令如下：

***

### 0. 网络管理 (Network)

用于管理 CLI 可识别的网络定义。第一版网络管理只负责注册链的元信息，不自动配置 RPC、浏览器或代币列表；它的作用是让 `wallet import private-key --chain ...`、`wallet switch --chain ...`、`wallet ls --chain ...` 等命令能够识别“内置链 + 用户自定义链”。

#### 0.1 添加网络 (Add)

* **命令签名**：
    `deu network add --id <network-id> --name <display-name> --ecosystem <ethereum|solana|bitcoin> [--aliases <a,b,c>]`[0]
* **参数说明**：
    * `--id` (必填): 网络唯一标识，供 CLI 内部持久化与命令行引用使用。建议使用小写字母、数字、`-`、`_` 组合，例如 `xlayer`、`linea`、`avalanche`。
    * `--name` (必填): 面向人类展示的网络名称，例如 `BNB Smart Chain`。
    * `--ecosystem` (必填): 该网络映射到的底层生态类型。目前支持 `ethereum`、`solana`、`bitcoin`。这决定了地址格式校验、HD 派生方式与私钥处理逻辑。
    * `--aliases <a,b,c>` (可选): 额外可识别别名，使用逗号分隔，例如 `bnb,bnbchain`。
* **业务逻辑**：
    * 该命令会把自定义网络写入本地状态文件，供后续所有 `--chain` 场景复用。
    * 自定义网络不能与任何内置网络或已有自定义网络的 `id / alias` 冲突。
    * 由于当前实现是“生态映射层”，所以新增网络本质上是在声明“这个链按哪类底层生态处理”。例如把 `xlayer` 或 `linea` 映射到 `ethereum` 后，即可复用 EVM 私钥格式校验与 EVM 地址展示逻辑。

#### 0.2 查看支持的网络 (List)

* **命令签名**：
    `deu network ls [--ecosystem <ethereum|solana|bitcoin>]`[0]
* **参数说明**：
    * `--ecosystem` (可选): 仅查看指定底层生态下的网络定义。
* **业务逻辑**：
    * 默认输出全部内置网络与本地已添加的自定义网络。
    * 推荐输出字段包括 `Id | Name | Ecosystem | Source | Aliases`，其中 `Source` 用于区分 `builtin` 与 `custom`。

### 1. 钱包创建 (Create)

创建全新的 HD 钱包（默认生成 12 位助记词）。

* **命令签名**：
    `deu wallet create [--alias <name>]`[3]
* **参数说明**：
    * `--alias` (可选): 为钱包指定别名。
* **业务逻辑**：
    * 如果不输入 `--alias`，系统将在后台随机生成一个可读的英文单词作为默认别名。
    * 在本地加密存储生成的助记词，并初始化该别名的派生索引（`next_account_index = 0`）。
    * 默认不在 stdout 明文打印助记词；如需备份，应走单独的受保护导出流程。
    * 创建成功时，stdout 默认仅返回钱包元数据，如 `alias`、`type`、默认地址和创建状态。

### 2. 钱包导入 (Import)

为了降低命令歧义，导入命令按导入来源拆分为两类子命令。

#### 2.1 助记词导入
* **命令签名**：
    `deu wallet import mnemonic [--alias <name>] [--from-stdin | --from-file <path>]`[3]
* **参数说明**：
    * `--from-stdin` / `--from-file <path>` (二选一，必填): 12 或 24 个英文助记词的安全输入来源。系统需包含对单词拼写及 Checksum 的基础校验，错误时抛出明确提示。
    * `--alias` (可选): 同上，缺省则随机生成英文单词。

#### 2.2 单链私钥导入
* **命令签名**：
    `deu wallet import private-key --chain <chain_name> [--alias <name>] [--from-stdin | --from-file <path>]`[3]
* **参数说明**：
    * `--chain` (必填): 目标公链标识。**支持用户直觉输入**（忽略大小写，支持缩写如 `btc`, `sol`, `bsc`, `polygon`）。系统内部（Mapping 层）会自动将其映射为底层 SDK 支持的生态标识（如将 `bsc` 和 `polygon` 统一映射到 `ethereum` 模块处理）。若目标链并非内置，可先通过 `deu network add ...` 注册为本地自定义网络。
    * `--from-stdin` / `--from-file <path>` (二选一，必填): 对应公链的私钥安全输入来源。系统会校验私钥格式是否与 `--chain` 匹配（如 SOL 为 Base58/ByteArray，EVM 为 Hex）。不匹配则报错。
    * `--alias` (可选): 同上，缺省则随机生成英文单词。

### 3. 钱包派生 (Derive)

从已有的 HD 钱包（助记词）按照 BIP44 路径派生出新的子钱包。

* **命令签名**：
    `deu wallet derive --from <name1> [--alias <name2>]`[3]
* **参数说明**：
    * `--from` (必填): 父钱包别名。必须是本地已存在的**助记词钱包**，若目标是单私钥钱包则报错提示“无法从此类钱包派生”。
    * `--alias` (可选): 新派生钱包的别名。
* **业务逻辑**：
    * HD 钱包的一个 alias 代表同一助记词根下的一个“账户槽位”，该槽位可映射到多条链上的一组地址。
    * 读取 `<name1>` 的 `next_account_index`。
    * 基于该 index 为支持的链生成同一组派生地址，随后将 `<name1>` 的 `next_account_index` 状态 +1 并持久化保存。

### 4. 钱包展示 (List)

展示本地存储的所有钱包资源。

* **命令签名**：
    `deu wallet ls [--chain <chain_name>]`[0]
* **参数说明**：
    * `--chain` (可选): 过滤特定公链的地址。
* **业务逻辑（防信息过载机制）**：
    * **默认无参执行**：针对单私钥钱包，直接展示对应公链的地址；针对助记词钱包，仅展示核心生态的默认地址（如 Ethereum 主网、Solana 主网、Bitcoin 默认地址），避免打印过多低频链地址导致刷屏。
    * **带参执行**：例如输入 `deu wallet ls --chain solana`，则全局扫描，仅打印所有别名下对应的 Solana 地址。
    * **输出格式**：推荐使用表格形式，列出 `Alias | Type (HD/PK) | Chain | Address`。

### 5. 状态激活 (Switch)

切换并激活全局 CLI 上下文，为后续自动化脚本或交易命令提供默认调用目标。

* **命令签名**：
    `deu wallet switch --alias <name> [--chain <chain_name>]`[0]
* **参数说明**：
    * `--alias` (必填): 需要激活的钱包别名。
    * `--chain` (条件必填): 
        * 如果 `<name>` 指向的是**单私钥钱包**，此参数可省略（系统自动推断其对应的链）。
        * 如果 `<name>` 指向的是**助记词钱包**，此参数为必填，用于明确用户后续操作针对的是该 HD 钱包下的哪条链。
* **业务逻辑**：
    * 命令执行成功后，将当前的 `<alias>` 和 `<chain>` 写入本地配置文件（如 `~/.deu/config.json` 的 `current_context` 字段）。后续如 `deu transfer` 等命令将默认读取此上下文进行交易构建与签名。

### 6. 当前上下文 (Current)

读取当前激活的钱包上下文，便于脚本和AI Agent在执行关键交易前进行确认。

* **命令签名**：
    `deu wallet current`[0]
* **业务逻辑**：
    * 读取本地配置中的 `current_context`。
    * 推荐输出 `Alias | Type | Chain | Address`，并支持 `--json`。

### 6.1 链上资产查询 (Assets)

查询某个钱包地址在目标链上的链上资产，属于只读能力，不触碰助记词或私钥，标记为[0]。该能力用于让AI Agent在执行借贷、转账、swap或签名前，先稳定读取当前钱包的可用资产。

* **命令签名**：
    `deu wallet assets [--current | --alias <name> --chain <chain_name>] [--rpc <url>]`[0]
* **参数说明**：
    * `--current` (可选): 查询当前 `wallet switch` 激活的钱包上下文。未提供 `--alias` 时默认读取当前上下文。
    * `--alias` (可选): 查询指定钱包别名。
    * `--chain` (条件必填): 当使用 `--alias` 查询 HD 钱包时必填；单私钥钱包可省略。
    * `--rpc` (可选): 指定链上 RPC。Solana 默认读取 `SOLANA_RPC_URL`，若未设置则使用 `https://api.mainnet-beta.solana.com`。
* **业务逻辑**：
    * 第一版先支持 Solana 链资产查询，返回 SOL 原生余额与 SPL Token 非零余额（在 RPC 支持的前提下同时扫描标准 Token Program 与 Token-2022；若 RPC 不支持 Token-2022 查询则静默跳过）。
    * 返回结构应包含 `alias`、`type`、`chain`、`address`、`rpcUrl`、`native`、`tokens`。
    * `tokens` 中每个条目包含 `mint`、`tokenAccount`、`amount`、`decimals`、`rawAmount`，方便Agent直接做数值判断。
    * 若当前上下文不是 Solana，命令应返回稳定错误码，提示切换到 Solana 或显式传入 `--alias <name> --chain solana`。

### 6.2 资产转账 (Send)

向目标地址发送资产。原生资产与 SPL/ERC-20 都属于需要访问敏感资料但不直接暴露敏感资料的能力，标记为[1]。该命令应默认要求用户确认；Agent 自动化场景必须显式传入 `--yes` 才能广播，避免误转账。

* **命令签名**：
    `deu wallet send [--current | --alias <name> --chain <chain_name>] --to <address> --amount <amount> [--asset native|spl|erc20] [--mint <mint>] [--token <contract>] [--rpc <url>] [--fee-rate <sat/vB>] [--dry-run] [--yes]`[1]
* **参数说明**：
    * `--current` (可选): 使用当前 `wallet switch` 激活的钱包上下文。未提供 `--alias` 时默认读取当前上下文。
    * `--alias` (可选): 指定发送方钱包别名。
    * `--chain` (条件必填): 当使用 `--alias` 指向 HD 钱包时必填；单私钥钱包可省略。
    * `--to` (必填): 收款地址。系统会按目标链校验地址格式。
    * `--amount` (必填): 发送数量，使用人类可读单位，例如 `0.01` SOL、`0.001` ETH、`0.0001` BTC。
    * `--asset` (可选): `native`（默认）| `spl` | `erc20`。
    * `--mint` (条件必填): 当 `--asset spl` 时必填，为 SPL mint 地址。
    * `--token` (条件必填): 当 `--asset erc20` 时必填，为 ERC-20 合约地址。
    * `--rpc` (可选): 指定 RPC 或链上 API。Solana 默认读取 `SOLANA_RPC_URL`；EVM 链可读取 `<CHAIN>_RPC_URL`；Bitcoin 默认使用 `https://mempool.space/api`，也可通过 `BITCOIN_API_URL` 或 `--rpc` 覆盖。
    * `--fee-rate <sat/vB>` (可选): Bitcoin 转账手续费率。未传入时自动读取 mempool 推荐费率。
    * `--dry-run` (可选): 构建或估算交易但不广播，用于Agent执行前检查。
    * `--yes` (可选): 跳过交互式确认并广播，供自动化流程显式使用。
* **业务逻辑**：
    * **原生**：覆盖 Solana、EVM 生态链、Bitcoin。Solana 使用 `SystemProgram.transfer`；EVM 发送 `value`；Bitcoin 使用 P2WPKH UTXO、PSBT 与 mempool API 广播。
    * **SPL**：根据 mint 账户 owner 自动识别标准 Token Program 或 Token-2022。若收款方无 ATA，则由发送方付租金创建关联代币账户（需发送方持有足够 SOL）。
    * **ERC-20**：读取合约 `decimals`，调用 `transfer`；`--dry-run` 时估算 gas，不广播。
    * 返回结构在原生基础上可包含 `mint`、`tokenContract`、`decimals`、`tokenProgram`（SPL）。
    * 风险提示：_tax / rebasing / 黑名单等异常 ERC-20 可能导致转账失败或损失；无限授权应单独通过 `approve` 命令完成并显性确认。

### 6.3 ERC-20 授权 (Approve)

为 DEX、路由或聚合器预授权 ERC-20 花费额度，属于高敏感操作（可能被恶意 spender 滥用），标记为[1]。必须显式传入 `--spender`，且默认要求确认。

* **命令签名**：
    `deu wallet approve erc20 [--current | --alias <name> --chain <chain>] --token <contract> --spender <address> [--amount <amount> | --unlimited] [--rpc <url>] [--dry-run] [--yes]`[1]

### 7. 钱包重命名 (Rename)

修改已有钱包的别名。

* **命令签名**：
    `deu wallet rename --alias <old-name> --new-alias <new-name>`[0]
* **参数说明**：
    * `--alias` (必填): 当前钱包别名。
    * `--new-alias` (必填): 新别名，且不得与现有别名重复。

### 8. 钱包删除 (Remove)

删除本地钱包记录及其对应的敏感材料引用。

* **命令签名**：
    `deu wallet remove --alias <name> [--yes]`[4]
* **参数说明**：
    * `--alias` (必填): 待删除的钱包别名。
    * `--yes` (可选): 跳过交互式确认，供自动化流程显式使用。
* **业务逻辑**：
    * 默认要求用户二次确认。
    * 如果目标为单私钥钱包，则删除钱包元数据，并从Keychain中移除对应私钥项。
    * 如果目标为助记词派生钱包，则仅删除该 alias 与其地址元数据；只有当该助记词根已无任何 alias 引用时，才允许删除其对应的Keychain密钥项。

### 8.1 钱包卸载 (Uninstall)

一次性清空本地全部钱包数据，属于最高风险的销毁类操作。

* **命令签名**：
    `deu wallet uninstall [--yes]`[4]
* **参数说明**：
    * `--yes` (可选): 跳过交互式确认，供自动化流程显式使用。
* **业务逻辑**：
    * 默认要求用户二次确认，并走风险等级 4 的敏感授权流程。
    * 删除本地全部钱包记录，包括 HD 钱包、单私钥钱包、助记词分组元数据。
    * 删除所有关联的 Keychain 密钥项，并清空当前激活的钱包上下文。
    * 该命令只卸载本地钱包数据，不影响 CLI 程序本身是否已安装，但会重置 `isInitialized` 引导状态，使后续 `deu init` 可以重新执行首次引导流程。

### 9. 钱包导出 (Export)

在用户明确授权的前提下，导出助记词或私钥，用于备份或迁移。

* **命令签名**：
    `deu wallet export mnemonic --alias <name> [--to-file <path>]`[2]
    `deu wallet export private-key --alias <name> --chain <chain_name> [--to-file <path>]`[2]
* **参数说明**：
    * `--alias` (必填): 待导出的钱包别名。
    * `--chain` (条件必填): 导出单链私钥或从HD钱包导出特定链私钥时必填。
    * `--to-file <path>` (可选): 将导出结果写入指定文件；若省略，则走安全交互式显示流程。
* **业务逻辑**：
    * 导出前必须要求用户再次确认，并校验agent当前处于已解锁状态。
    * 默认不建议将敏感材料直接打印到标准输出；如确需显示，应有显式的高风险提示。

### 10. Jupiter Lend 集成（新增）

在现有 wallet 命令组之外，建议新增 `deu lend ...` 命令组，用于承接 Jupiter Lend 的 Earn 与 Borrow 能力。

#### 10.1 基于官方文档的当前能力边界

根据 https://developers.jup.ag/docs/lend/api-vs-sdk 当前文档，Jupiter Lend 的能力应拆成三层看待：

1. **REST API（偏后端、跨语言）**
   * 已可用：Earn token 列表、Earn positions、Earn earnings、Earn deposit/withdraw/mint/redeem 的 unsigned transaction 或 instructions。
   * 需要：`x-api-key`。
   * 适合：查询、快速接入、返回 unsigned tx 给本地钱包签名。
2. **Read SDK（偏只读链上查询，TS/JS）**
   * 已可用：Earn 的 jlToken 详情、用户 positions、preview；Borrow 的 vault 列表、vault 明细、用户全部 positions、按 vaultId+nftId 查询单仓位。
   * 需要：Solana RPC。
   * 适合：不依赖 API Key 的链上读取、做风控展示、做 preview 和仓位分析。
3. **Lend SDK（偏交易构建，TS/JS）**
   * 已可用：
     * Earn：`deposit / withdraw / mint / redeem` instruction builders。
     * Borrow：`create-position / deposit / borrow / repay / withdraw / liquidate` instruction builders。
   * 需要：Solana RPC。
   * 适合：本地构建交易，再交给 deuteron-agent 签名与广播。

当前**不建议**在第一版 CLI 中承诺的能力：

* Borrow REST API：官方文档明确写了 *coming soon*，因此不能把 Borrow 的 HTTP 接口设计成当前稳定能力。
* 不经 Solana RPC 的 Borrow 查询与构建：Borrow 当前必须依赖 Read SDK / Lend SDK。
* 直接把 Borrow 做成“纯 API 模式”的通用后端接口：现在没有稳定上游支撑。

#### 10.2 `deu lend` 命令的统一设计原则

为了避免把“查询、构建、签名、广播”揉成一个黑盒命令，`deu lend` 建议统一拆成三层：

1. `read` 层：只读查询，不需要私钥，标记为[0]。
2. `build` 层：构建 unsigned transaction 或 instruction payload，不需要私钥，标记为[0]。
3. `execute` 层：调用 deuteron-agent 使用当前 Solana 钱包签名并广播，标记为[1]。

公共约定如下：

* 所有 `lend` 命令继续支持 `--json`。
* 所有 `read` / `build` 命令都不触碰私钥，也不要求 Keychain 解锁。
* 所有 `execute` 命令都要求当前上下文为 Solana 钱包；若当前 `wallet current` 不是 Solana，则直接报错。
* Jupiter REST API 相关命令统一支持 `--api-key <key>`，若未传入，则回退读取环境变量 `JUP_API_KEY`。
* SDK 相关命令统一支持 `--rpc <url>`，若未传入，则回退读取环境变量 `SOLANA_RPC_URL`，否则默认主网 RPC。
* 凡是查询“某个用户”的命令，统一支持 `--owner <solana_address>` 或 `--current` 二选一；`--current` 表示读取当前激活的 Solana 地址。
* 所有 Borrow builder 命令使用 `--amount-raw` / `--debt-amount-raw` 这类显式字段名，强调传入的是最小单位整数，避免 UI 金额与原始金额混淆。

#### 10.3 Earn 只读查询命令

这部分优先级最高，因为它们不涉及签名，且官方 API / SDK 都已稳定。

##### 10.3.1 Earn token 列表
* **命令签名**：
    `deu lend earn tokens [--source <api|sdk|auto>] [--api-key <key>] [--rpc <url>]`[0]
* **用途**：
    * 列出当前所有可参与 Jupiter Earn 的资产、jlToken 地址、收益率、总资产、总份额等。
* **业务逻辑**：
    * `api` 模式走 REST `earn/tokens`。
    * `sdk` 模式走 Read SDK `getAllJlTokenDetails()`。
    * `auto` 模式优先 API；若缺少 API Key，则回退 SDK。

##### 10.3.2 Earn 用户仓位
* **命令签名**：
    `deu lend earn positions [--owner <address> | --current] [--source <api|sdk|auto>] [--api-key <key>] [--rpc <url>]`[0]
* **用途**：
    * 查询某 Solana 地址在 Jupiter Earn 中的持仓，包括 shares、underlyingAssets、wallet balance、allowance 等。
* **业务逻辑**：
    * API 模式走 `earn/positions`。
    * SDK 模式走 `getUserPositions(user)`。
    * 如果使用 `--current`，则只能在当前上下文为 Solana 时执行。

##### 10.3.3 Earn 收益查询
* **命令签名**：
    `deu lend earn earnings [--owner <address> | --current] --positions <mint1,mint2,...> [--api-key <key>]`[0]
* **用途**：
    * 查询某用户针对指定 Earn positions 的累计收益。
* **业务逻辑**：
    * 该能力当前是 **API only**，直接走 `earn/earnings`。
    * `--positions` 传入 underlying token 或 jlToken 对应的 position 标识列表，CLI 只做基础拆分，不做过度猜测。

##### 10.3.4 Earn preview
* **命令签名**：
    `deu lend earn preview --asset <mint> [--assets-raw <int>] [--shares-raw <int>] [--rpc <url>]`[0]
* **用途**：
    * 用 Read SDK 查询 deposit / mint / withdraw / redeem 的预估结果。
* **业务逻辑**：
    * 至少需要 `--assets-raw` 或 `--shares-raw` 其中之一。
    * 输出包括 `previewDeposit`、`previewMint`、`previewWithdraw`、`previewRedeem`。
    * 该命令只做预估，不构建交易。

#### 10.4 Earn 交易构建命令

这部分建议明确区分 `build` 和 `execute`。第一版完全可以先落 `build`，等体验确认后再加 `execute`。

##### 10.4.1 Earn build 命令
* **命令签名**：
    `deu lend earn deposit build --asset <mint> --amount <value> [--owner <address> | --current] [--source <api|sdk>] [--api-key <key>] [--rpc <url>] [--format <transaction|instructions>]`[0]
    `deu lend earn withdraw build --asset <mint> --amount <value> [--owner <address> | --current] [--source <api|sdk>] [--api-key <key>] [--rpc <url>] [--format <transaction|instructions>]`[0]
    `deu lend earn mint build --asset <mint> --shares <value> [--owner <address> | --current] [--source <api|sdk>] [--api-key <key>] [--rpc <url>] [--format <transaction|instructions>]`[0]
    `deu lend earn redeem build --asset <mint> --shares <value> [--owner <address> | --current] [--source <api|sdk>] [--api-key <key>] [--rpc <url>] [--format <transaction|instructions>]`[0]
* **用途**：
    * 构建未签名交易，供用户或 agent 审查后再签名。
* **业务逻辑**：
    * `source=api`：优先取 Jupiter API 返回的 base64 unsigned transaction；若显式要求 `instructions`，则调用对应的 `*-instructions` 接口。
    * `source=sdk`：调用 `getDepositIxs / getWithdrawIxs / getMintIxs / getRedeemIxs`，输出原始指令列表。
    * 这类命令默认不广播。

##### 10.4.2 Earn execute 命令
* **命令签名**：
    `deu lend earn deposit execute --asset <mint> --amount <value> [--source <api|sdk>] [--api-key <key>] [--rpc <url>]`[1]
    `deu lend earn withdraw execute --asset <mint> --amount <value> [--source <api|sdk>] [--api-key <key>] [--rpc <url>]`[1]
    `deu lend earn mint execute --asset <mint> --shares <value> [--source <api|sdk>] [--api-key <key>] [--rpc <url>]`[1]
    `deu lend earn redeem execute --asset <mint> --shares <value> [--source <api|sdk>] [--api-key <key>] [--rpc <url>]`[1]
* **用途**：
    * 使用当前 Solana 钱包完成签名并广播。
* **业务逻辑**：
    * CLI 负责从 API 或 SDK 拿到 unsigned tx / instructions。
    * deuteron-agent 负责签名。
    * 返回结果应包含 `signature`、`slot/confirmation status`、以及原始 `txid`。

#### 10.5 Borrow 只读查询命令

Borrow 当前的查询能力应完全建立在 Read SDK 上。

##### 10.5.1 Vault 列表与明细
* **命令签名**：
    `deu lend borrow vaults [--rpc <url>]`[0]
    `deu lend borrow vault --vault-id <id> [--rpc <url>]`[0]
* **用途**：
    * 查询所有 Borrow vault，或查询单个 vault 的风险参数、可借额度、oracle、borrowable、withdrawable 等。
* **业务逻辑**：
    * `vaults` 对应 `getAllVaults()`。
    * `vault` 对应 `getVaultByVaultId(vaultId)`。

##### 10.5.2 Borrow 用户仓位
* **命令签名**：
    `deu lend borrow positions [--owner <address> | --current] [--rpc <url>]`[0]
    `deu lend borrow position --vault-id <id> --position-id <nft_id> [--rpc <url>]`[0]
* **用途**：
    * 查询某地址在所有 vault 中的 Borrow 仓位，或查询某个特定 position NFT 的详情。
* **业务逻辑**：
    * `positions` 对应 Read SDK `getAllUserPositions(user)`。
    * `position` 对应 `getPositionByVaultId(vaultId, nftId)`。
    * 输出建议展示 `vaultId`、`nftId`、`supply`、`borrow`、`tick`、`isLiquidated`、`liquidationThreshold`。

#### 10.6 Borrow 交易构建命令

Borrow 当前不应设计成 API 模式，而应明确写死为 SDK 模式。

##### 10.6.1 Borrow build 命令
* **命令签名**：
    `deu lend borrow create-position build --vault-id <id> [--owner <address> | --current] [--rpc <url>]`[0]
    `deu lend borrow deposit build --vault-id <id> --position-id <nft_id|0> --amount-raw <int> [--owner <address> | --current] [--rpc <url>]`[0]
    `deu lend borrow borrow build --vault-id <id> --position-id <nft_id> --amount-raw <int> [--owner <address> | --current] [--rpc <url>]`[0]
    `deu lend borrow repay build --vault-id <id> --position-id <nft_id> --amount-raw <int> [--owner <address> | --current] [--rpc <url>]`[0]
    `deu lend borrow withdraw build --vault-id <id> --position-id <nft_id> --amount-raw <int> [--owner <address> | --current] [--rpc <url>]`[0]
    `deu lend borrow liquidate build --vault-id <id> --debt-amount-raw <int> [--to <address>] [--owner <address> | --current] [--rpc <url>]`[0]
* **用途**：
    * 构建 Borrow 相关的 instruction payload 或 unsigned transaction。
* **业务逻辑**：
    * `create-position` 对应 `getInitPositionIx()`。
    * `deposit / borrow / repay / withdraw` 统一走 `getOperateIx()`。
    * `liquidate` 走 `getLiquidateIx()`。
    * 当 `position-id = 0` 时，允许“创建仓位 + 首次抵押”在同一交易内完成。
    * `repay` 与 `withdraw` 内部会分别把正数金额映射成 SDK 需要的负债务值 / 负抵押值，但 CLI 对外仍保持正数输入，避免用户心智负担。

##### 10.6.2 Borrow execute 命令
* **命令签名**：
    `deu lend borrow create-position execute --vault-id <id> [--rpc <url>]`[1]
    `deu lend borrow deposit execute --vault-id <id> --position-id <nft_id|0> --amount-raw <int> [--rpc <url>]`[1]
    `deu lend borrow borrow execute --vault-id <id> --position-id <nft_id> --amount-raw <int> [--rpc <url>]`[1]
    `deu lend borrow repay execute --vault-id <id> --position-id <nft_id> --amount-raw <int> [--rpc <url>]`[1]
    `deu lend borrow withdraw execute --vault-id <id> --position-id <nft_id> --amount-raw <int> [--rpc <url>]`[1]
    `deu lend borrow liquidate execute --vault-id <id> --debt-amount-raw <int> [--to <address>] [--rpc <url>]`[1]
* **用途**：
    * 使用当前 Solana 钱包执行 Borrow 相关交易。
* **业务逻辑**：
    * CLI 构建交易，agent 负责签名与广播。
    * `create-position execute` 成功后应额外返回 `nftId`，供后续命令直接引用。
    * `deposit / borrow / repay / withdraw` 默认返回 `signature` 与最新的 position 摘要。

#### 10.7 建议的第一阶段实现范围

为了控制复杂度，建议在第一阶段只承诺以下命令进入正式实现：

1. `deu lend earn tokens`
2. `deu lend earn positions`
3. `deu lend earn earnings`
4. `deu lend earn preview`
5. `deu lend earn <deposit|withdraw|mint|redeem> build`
6. `deu lend borrow vaults`
7. `deu lend borrow vault`
8. `deu lend borrow positions`
9. `deu lend borrow position`
10. `deu lend borrow <create-position|deposit|borrow|repay|withdraw|liquidate> build`

也就是说，**第一阶段先把“读”和“构建”做好，不急着默认实现 `execute`**。这样既符合 deuteron 当前“CLI + agent”分层，也能让 AI Agent 在签名前先审阅输出的 unsigned tx / instructions，降低误操作风险。

## 成品结果

最终可以被打包成一个能通过`npm install`安装的执行程序。同时为了方便开发和调试，我希望在本地开发时，不需要频繁构建/编译 TS 代码。请通过配置 package.json 的 scripts 脚本（结合 tsx 或 ts-node），实现可以直接在项目根目录下敲击 pnpm deu create wallet 来直接运行和调试 TypeScript 源码，且能正确接收后面的参数。当用户通过pnpm或npm安装之后，自动为其将命令行添加至环境变量（在macOS上自动添加至～/.zshrc），用户输入`deu init`会显示 **“ASCII Art 欢迎横幅 (Banner)”** 和 **“首次运行引导流程 (Onboarding)”** 。

***

> **CLI 欢迎横幅 (Banner) 与首次引导 (Onboarding) 需求**
>
> 1. **ASCII Art 欢迎大字**：请在 CLI 初始化或首次运行时（如执行 `deu init` 时），在终端顶部打印一个酷炫的文字 Logo。可以使用 `figlet` 库生成 “DEUTERON” 的大号花体字，并配合 `chalk` 或 `gradient-string` 加上渐变颜色。
> 2. **首次引导与免责声明 (Onboarding Flow)**：在打印完 Logo 后，接着输出一段格式化的文本块。包含：
>    * **简短原理介绍**：说明本项目采用了 Agent 守护进程 + 本地 Keychain 的安全架构。
>    * **安全须知 / 声明**：提醒用户助记词的存储机制及风险提示。请使用 `cli-table3` 或 `boxen` 将这段文字框起来，以示醒目。
>    * **交互式确认**：在打印完上述须知后，使用 `inquirer` 或 `prompts` 阻断流程，要求用户输入 `y` 或 `I Agree` 才能继续生成/导入钱包的后续流程。
> 3. **状态标记**：完成上述引导后，在本地配置文件中标记 `isInitialized: true`，确保用户以后日常调用转账等命令时，不再重复显示这串冗长的欢迎语。

***
solana是最适合agent交易的链，庞大市场，币 股 卡牌，用一套sdk交易所有

第一个项目agent私钥管理问题

后续：集成支付、专属rpc

agent使用情况？积分系统