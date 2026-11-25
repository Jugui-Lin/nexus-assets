# Nexus 0.7 与 Connecter 功能对照

以 Windows 桌面上整理本地和 NAS 三维资产、浏览预览、向 DCC 放置资产的流程为范围。Connecter 的 Personal 和 Suite 功能均列入对照。产品功能参考 Connecter 帮助中心，Nexus 验证范围见文末。

## 已实现

| 功能 | Nexus 0.7 |
| --- | --- |
| 添加与浏览文件夹 | 个人库可在系统对话框多选文件夹，也可拖入多个文件或文件夹。目录树保留扫描到的空子目录，支持路径导航、递归筛选、固定和重新扫描。团队库根据共享索引中的资产路径展示目录。素材留在原位置。[Connecter 添加文件夹](https://designconnected.zendesk.com/hc/en-us/articles/22574416824722-Adding-Folders-to-Connecter) |
| 资产区快速筛选 | 主栏按资产类型筛选，快捷按钮按收藏、标签、备注、封面和近期入库组合筛选，并显示数量。文件名筛选作用于当前浏览范围，适合和顶部全文搜索、格式、评分及工作流状态叠加使用。[Connecter 搜索与筛选](https://designconnected.zendesk.com/hc/en-us/articles/12981713976466-Overview-of-the-Search-and-Filtering-Functionalities) |
| 保存搜索与整理 | 保存搜索可重用当前目录、文件名和筛选条件，并针对当前索引重新执行。支持层级标签、个人合集、多选整理和拖动卡片归类。[Connecter 动态子集](https://designconnected.zendesk.com/hc/en-us/articles/10903272143250-Dynamic-Subsets) · [Connecter 标签](https://designconnected.zendesk.com/hc/en-us/articles/11916717807762-Tags) |
| 预览 | 支持图片、自定义封面、2 至 4 项并排对比，以及 OBJ、STL、PLY、GLB 和内嵌几何 glTF 的静态三维预览。左右面板可独立折叠和调整。[Connecter 资产预览](https://designconnected.zendesk.com/hc/en-us/articles/18054899853586-Asset-Previewing) |
| DCC 视口放置 | 更新桥接并重启宿主后，可向已连接的 Blender 或 Cinema 4D 拖放受支持的模型，在视口查看位置、旋转并确认或取消。Cinema 4D 使用线框预览。已连接的其他宿主仍可接收桥接导入任务，Windows 文件拖放可将原文件交给支持格式的目标软件。[Connecter Blender 拖放](https://designconnected.zendesk.com/hc/en-us/articles/10900222765970-Drag-Drop-Importing-of-Assets-in-Blender) · [Connecter Cinema 4D 集成](https://designconnected.zendesk.com/hc/en-us/articles/10900466010898-Overview-of-the-Cinema-4D-Integration) |
| 安装 DCC 桥接 | 连接中心检测支持的版本，为 Blender、Cinema 4D、Maya、3ds Max 和 Houdini 提供自动安装与更新，显示安装及在线状态。另有导出脚本入口。[Connecter 集成中心](https://designconnected.zendesk.com/hc/en-us/articles/35797528936850-Integrations-Hub) |
| 管理工作空间 | 顶部入口可创建、打开、切换和迁移个人库，或连接团队服务。迁移复制当前数据库、封面和版本文件，保留源目录。个人库和团队库独立管理。[Connecter 管理工作空间](https://designconnected.zendesk.com/hc/en-us/articles/10891239482130-Managing-Workspaces-in-Connecter) |
| 团队协作与个人版本 | 自托管服务同步共享索引、标签、备注、评分和状态。各成员映射自己的 NAS 路径，服务端检测变更后客户端刷新。个人库支持带备注的文件快照和历史版本副本导出。[Connecter 服务器数据](https://designconnected.zendesk.com/hc/en-us/articles/19647899941266-Which-of-Your-Data-is-Stored-on-Connecter-s-Servers) · [Connecter 版本控制](https://designconnected.zendesk.com/hc/en-us/articles/10902850629522-Version-Control-in-Connecter) |

## 尚有差距

| 功能 | 尚未覆盖 |
| --- | --- |
| 目录与筛选 | 完整的文件夹隐藏、忽略、颜色和排序管理。复杂布尔搜索语法、渲染器筛选、各文件夹自动记忆全部筛选设置。[Connecter 文件夹管理](https://designconnected.zendesk.com/hc/en-us/articles/22574416824722-Adding-Folders-to-Connecter) · [Connecter 搜索运算符](https://designconnected.zendesk.com/hc/en-us/articles/12981802559250-Search-Operators) |
| DCC 深度操作 | 从宿主发布物体、集合和材质并自动渲染封面。场景对象及关联实例替换、材质匹配替换、代理、XRef 和依赖整理尚待实现。[Connecter 从 Blender 添加资产](https://designconnected.zendesk.com/hc/en-us/articles/10900219601298-Adding-Assets-from-Blender) · [Connecter Cinema 4D 功能记录](https://designconnected.zendesk.com/hc/en-us/articles/10900406927378-Cinema-4D-Integration-Changelog) |
| 媒体与预览 | C4D、FBX、USD、BLEND 等格式在资产管理台内的原生三维预览、动画、音视频、PBR 材质和预览图集。[Connecter 资产预览](https://designconnected.zendesk.com/hc/en-us/articles/18054899853586-Asset-Previewing) |
| 团队版本与共享 | 团队版本存储、签入签出、逐版本状态、恢复历史版本、托管备份和云端预览。Web Catalog 的对外分享、合作方邀请与权限管理也尚未实现。[Connecter 版本控制](https://designconnected.zendesk.com/hc/en-us/articles/10902850629522-Version-Control-in-Connecter) · [Connecter Web Catalog](https://designconnected.zendesk.com/hc/en-us/articles/16317821023634-Web-Catalog-Setup-and-Activate) |
| 审核与评分 | 成员独立星级、平均分、点赞和票数汇总，以及自定义字段、评论和审核记录。[Connecter 评分](https://designconnected.zendesk.com/hc/en-us/articles/13368628322066-Ratings) |

## 验证范围

Cinema 4D 已通过独立模拟测试，覆盖放置前无场景写入、确认后生成一组撤销记录、取消、切换项目及导入失败回滚。Cinema 4D 真实视口中的跨窗口放置仍需实机确认。Blender 及 Windows 桌面验证范围见 [README](README.md)。
