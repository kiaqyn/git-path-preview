# Git Path Preview

在检出之前，检查 Git 提交里的路径在指定 Windows 目标目录下可能遇到的问题。

需要 Node.js 20 或更高版本，以及 Git 2.45 或更高版本；无需安装 npm 依赖。Git 2.45 是阻止按需自动下载所用 `--no-lazy-fetch` 选项的基准；带相应补丁的较旧版本可能可用，但尚未验证。

从源码目录运行：

```powershell
# 检查已在本机的仓库
node preview.mjs C:\path\to\repo C:\target\checkout

# 检查公开 HTTPS Git 仓库的默认分支
node preview.mjs https://github.com/OWNER/REPO.git C:\target\checkout --remote

# 输出 JSON，或指定本地仓库中的提交
node preview.mjs C:\path\to\repo C:\target\checkout --ref main --json

# 自定义长度告警阈值
node preview.mjs C:\path\to\repo C:\target\checkout --threshold 260

# 运行测试
node --test test.mjs
```

第二个路径是准备检出到的完整目录。结果包括路径长度告警，以及常见的保留设备名称、非法字符、结尾空格或点、目录和文件大小写冲突。文本模式会列出全部超长告警；没有超长告警时展示最长的十条路径。退出码：0 无发现，1 有发现，2 输入或 Git 运行错误。

`git_metadata_name` 会提示名称恰好为 `.git` 或 `git~1` 的路径组件，不区分大小写；在本机测试中，Git for Windows 在 `core.protectNTFS=true` 时拒绝检出这些名称。这是保守提示，并未覆盖所有 Git 元数据别名或所有配置。

`git_ntfs_device_name` 会提示 `LPT0`、`CONIN$` 和 `CONOUT$` 名称，包括带扩展名的形式，不区分大小写。在本机测试中，Git for Windows 启用 `core.protectNTFS=true` 时拒绝所测名称；其他 Git 和文件系统配置下行为可能不同，告警不代表所有配置都会失败。

工具会规范化目标路径；盘符或 UNC 共享名后面的目录组件若含 `|`、`:` 等 Windows 无效字符，会作为输入错误停止。这不是文件系统探测：不验证 UNC 服务器及共享名、目标是否存在、权限或所有特殊名称行为。

报告会列出实际检查的 Git tree 对象 ID。分支名可能在两次运行之间变化，该 ID 可用于确认具体检查了哪棵目录树。本地 `--ref` 可以指向提交、标签或 tree 对象。

若环境设置了 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_COMMON_DIR`、`GIT_OBJECT_DIRECTORY`、`GIT_ALTERNATE_OBJECT_DIRECTORIES` 或 `GIT_NAMESPACE`，命令会报错停止，因为这些变量可能改变 Git 对仓库、对象或引用的查找。请在不带这些变量的新终端中运行；远程模式也有此限制。参见 [Git 环境变量文档](https://git-scm.com/docs/git#_environment_variables)。

工具读取对象时会忽略 Git 替换引用（`refs/replace`），使结果对应报告中的原始对象 ID。若本地仓库使用了替换引用，普通 Git 检出可能采用替换后的内容，行为可能不同；文本与 JSON 报告会标明这一点。

## 从 GitHub Release 获取

在 [v0.1.0 发布页](https://github.com/kiaqyn/git-path-preview/releases/tag/v0.1.0) 下载 `git-path-preview-0.1.0.tgz`，可用附件 `SHA256SUMS.txt` 核对摘要，然后按下面的方法安装。需要 Node.js 20+ 和 Git 2.45+；没有发布到 npm 注册表。

## 在 Windows 安装本地压缩包

安装包是本地文件，不是 npm 上的发布版本。安装 Node.js 和 Git 后，在希望存放本地安装的目录打开 PowerShell，执行下面的命令，并把示例路径换成自己的路径：

```powershell
npm install --offline --no-audit --no-fund "C:\安装包路径\git-path-preview-0.1.0.tgz"
node .\node_modules\git-path-preview\preview.mjs "C:\仓库路径" "C:\目标检出目录" --json
$LASTEXITCODE
```

安装位于当前目录，不会添加全局命令。PowerShell 中建议使用上面的 `node` 直接调用：npm 也会生成 `.cmd` 启动脚本，但 PowerShell 调用该脚本时，参数中的 `&`、`|` 等可能被命令解释器当作语法而拆开。`--offline` 阻止 npm 下载依赖；若使用工具的 `--remote`，Git 仍会访问远程服务器。退出码 1 表示发现告警，2 表示发生错误。安装包包含程序和文档，但不含 `test.mjs`；测试请从源码目录运行。在源码目录运行 `npm pack` 可重新生成本地安装包。包配置为私有以防误发布，目前没有发布到 npm。

本地模式禁止 Git 按需获取缺失对象，不修改文件或 Git 配置。如果部分克隆缺少所需的目录树对象，扫描会报错，不会悄悄下载；请先通过可信方式自行获取缺失对象。远程模式会访问目标服务器，将默认分支浅克隆到新建的临时裸仓库，结束后删除临时目录；不创建工作目录。该操作需要网络，且在服务器不支持过滤时可能下载较多数据。远程模式只接受不含凭据、查询参数或片段的 HTTPS 地址，超时为 120 秒；不会交互式询问密码。其他分支请先通过可信方式获取到本地，再使用 `--ref`。

远程克隆前，工具会让 Git 在不连接远程服务器的情况下解析 `url.*.insteadOf` 改写；如果地址被改写，即使目标仍是 HTTPS 也会停止。需要地址改写的用户可检查自己的 Git 配置，或先使用可信方式获取本地仓库。这是预检查，不是网络隔离：检查和克隆之间配置可能变化，Git 仍可能使用已配置的代理或跟随 HTTP 重定向。

**检查结果仅供参考。** 260 个 UTF-16 代码单元是可配置的经验阈值，实际能否检出取决于 Git、Windows、文件系统和其他应用。目标目录可以使用正斜杠或反斜杠，但不支持 `\\?\C:\...` 等 Windows 设备命名空间路径。该工具不检查子模块内部、生成文件、文件权限和所有 NTFS 规则；大小写比较只是近似。没有告警不代表一定能成功。分享报告前请检查是否包含敏感路径。

问题有真实案例，但同类工具也已经存在：见 [Git for Windows 的说明](https://gitforwindows.org/faq.html)、[GitHub Desktop 报告](https://github.com/desktop/desktop/issues/17882) 和 [git-path-audit](https://github.com/bunta-expert/git-path-audit)。目前仍需真实用户验证这个具体工具是否有价值。

按各项目文档，[git-path-audit v0.0.1](https://github.com/bunta-expert/git-path-audit/blob/v0.0.1/README.md) 可扫描索引、暂存更改或指定 tree，覆盖 Unicode 规范化等更多规则，但明确不提供路径长度策略；本工具估算指定 Windows 目标目录的路径长度，也可检查远程默认分支，但没有那些扩展 Unicode 规则，也不扫描索引或暂存更改。[winpathlint v0.2.0](https://github.com/otrumb/winpathlint/blob/v0.2.0/README.md) 扫描索引并检查仓库相对路径长度，不支持指定提交或远程模式。[gclo](https://github.com/KofTwentyTwo/gclo) 主要用于批量克隆和更新仓库，不是直接同类。这些是基于文档的功能对照，并非独立性能比较或需求验证。

具体公开仓库案例及验证边界见 [VALIDATION.md](VALIDATION.md)。

## 许可证

尚未选择项目许可证，见 [NOTICE.md](NOTICE.md)。
