# 在 NAS 运行 Nexus 团队服务

把部署文件放在 NAS 的本地存储卷上。团队服务统一读写 `data/team.sqlite3`，其中保存团队目录索引、标签、备注和成员信息。每台电脑通过同一个团队服务地址同步索引和资料，并通过 NAS 共享目录访问素材。

## 安装

1. 在 NAS 上的专用目录解压部署文件。保持 `compose.yaml`、`data`、`nas`、`src-tauri` 和 `resources` 的目录结构。
2. 确认 Compose 配置中的地址是 NAS 的私网 IPv4，端口可用。容器默认使用 UID/GID `1000:1000`，这个用户需要对 `data` 目录和已有数据库有读写权限。若 NAS 上的目录所有者不同，可在部署目录的 `.env` 中指定 `NEXUS_TEAM_UID` 和 `NEXUS_TEAM_GID`。
3. 在这一目录运行 `docker compose up -d --build`。如果通过 UGOS 的「Docker → 项目」部署，项目的配置保存目录也须包含解压后的完整内容。首次构建需要 NAS 可以访问 Docker 镜像仓库和 Rust 依赖仓库。已安装 Docker 的 Linux 电脑也可构建镜像。 [UGOS Compose 指南](https://support.ugnas.com/knowledgecenter/detail/article/zh-CN/411)
4. 查看 `docker compose logs nexus-team`，确认服务在 NAS 的地址上监听。Nexus 的「团队工作空间」使用 `http://NAS的私网IPv4:端口` 连接。通过内网 HTTP 连接时，勾选「允许受信任私网内使用 HTTP」。

## 已有团队

包含 `data/team.sqlite3` 的迁移包可以直接部署。为了保留成员身份，请让成员在切换前用 0.9.1 打开原团队并同步一次。导出和切换期间暂停团队编辑，以免两份数据库分别产生新改动。NAS 服务验证成功后，用「NAS 团队 → 切换到 NAS 地址」连接。同事仍可在「管理团队库 → 设置挂载」设置其访问 NAS 素材的本机路径。

空白部署若需要创建全新团队，先在部署目录运行：

```sh
docker compose build
docker compose run --rm --no-deps nexus-team --data /var/lib/nexus init "设计团队" "管理员"
docker compose up -d
```

初始化只对没有团队的数据库生效。请保存初始化输出的管理员访问密钥。

## GitHub 镜像自动更新

将 `nas/compose.update.yaml` 放到团队服务项目目录，在 NAS 主机的计划任务中执行下面的命令。把目录、项目名和 Compose 文件名换成现有部署的值。

```sh
sh /path/to/nas/update-team.sh --project-directory /path/to/nexus-team --project-name nexus-team --compose-file docker-compose.yaml
```

脚本追踪 `ghcr.io/jugui-lin/nexus-team:stable`，保留 Compose 的原数据绑定，停服备份 SQLite 后按镜像摘要更新。启动检查失败时尝试回到原镜像，并在项目的 `.nexus-team-update/blocked` 记录结果。备份保存在 `.nexus-team-update/backups`。

现有部署若附带百度网盘的 `bdpan`，可将 NAS 上的可执行文件以只读方式挂载到 `/usr/local/bin/bdpan`。定时任务应由有 Docker 权限的 NAS 管理账号运行，脚本和 Compose 配置应放在该账号控制的目录。

## 服务器自动扫描素材

把 NAS 上实际的素材文件夹作为只读卷挂载进容器。0.9.5 起，可以在 `nexus-team` 服务的 Compose 配置中同时填写 `NEXUS_TEAM_WATCH_LIBRARY`（已有团队库的编号）和 `NEXUS_TEAM_WATCH_ROOT`（容器内的素材路径），服务启动时会登记自动扫描。保留原有数据库数据卷。成员对这个共享目录里的素材进行新增、修改或移动后，NAS 更新索引，客户端自动同步。

也可以通过 `library-watch` 指定要扫描的目录：

```sh
docker compose exec nexus-team nexus-team --data /var/lib/nexus libraries
docker compose exec nexus-team nexus-team --data /var/lib/nexus library-watch '库编号' '/mnt/素材/库名'
```

团队服务在指定的私网地址上监听。若启用了按地址加入，所有能访问该端口的设备都可注册普通成员。请在受信任的内网使用地址加入。
