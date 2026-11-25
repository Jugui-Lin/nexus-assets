#!/bin/sh
set -eu
umask 077

service=nexus-team
repository=ghcr.io/jugui-lin/nexus-team
project_directory=
project_name=
compose_file=compose.yaml

log() { printf '%s\n' "$*" >&2; }
fail() { log "$@"; exit 1; }
usage() {
    printf '%s\n' '用法：sh nas/update-team.sh --project-directory 目录 [--project-name 项目名] [--compose-file Compose文件]'
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --project-directory|--project-name|--compose-file)
            [ "$#" -ge 2 ] && [ -n "$2" ] || fail "参数 $1 缺少值。"
            case "$1" in
                --project-directory) project_directory=$2 ;;
                --project-name) project_name=$2 ;;
                --compose-file) compose_file=$2 ;;
            esac
            shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *) usage; fail "未知参数 $1。" ;;
    esac
done

[ -n "$project_directory" ] || { usage; exit 2; }
cd "$project_directory" || fail '无法打开项目目录。'
project_directory=$(pwd -P)
case "$compose_file" in
    /*) ;;
    *) compose_file=$project_directory/$compose_file ;;
esac
compose_directory=$(cd "$(dirname "$compose_file")" && pwd -P)
compose_file=$compose_directory/$(basename "$compose_file")
override=$project_directory/compose.update.yaml
[ -f "$compose_file" ] || fail "找不到 Compose 文件 $compose_file。"
if [ ! -f "$override" ]; then
    log '未找到 compose.update.yaml，团队服务保持原来的部署方式。'
    exit 0
fi

for command in docker curl flock tar awk mktemp; do
    command -v "$command" >/dev/null 2>&1 || fail "无法找到命令 $command。"
done

state=$project_directory/.nexus-team-update
[ ! -L "$state" ] || fail '更新状态目录应是项目内的普通目录。'
mkdir -p "$state"
[ ! -L "$state/lock" ] || fail '更新锁路径异常。'
exec 9>"$state/lock"
if ! flock -n 9; then
    log '该项目已有更新检查正在执行。'
    exit 0
fi
[ ! -L "$state/blocked" ] && [ ! -e "$state/blocked" ] ||
    fail "上次更新未完成或未通过检查。请查看 $state/blocked。"
[ ! -d "$state/current.env" ] || fail '当前镜像记录路径异常。'

base_compose() {
    if [ -n "$project_name" ]; then
        docker compose --project-directory "$project_directory" --project-name "$project_name" -f "$compose_file" "$@"
    else
        docker compose --project-directory "$project_directory" -f "$compose_file" "$@"
    fi
}

inspect_container() { docker container inspect --format "$1" "$2"; }
single_container() {
    case "$1" in
        ''|*[!0-9a-f]*) return 1 ;;
        *) [ "${#1}" -ge 12 ] && [ "${#1}" -le 64 ] ;;
    esac
}

container=$(base_compose ps -a -q "$service") || fail '无法读取 Compose 项目。'
single_container "$container" || fail '项目中需要且只能有一个 nexus-team 容器。'
[ "$(inspect_container '{{index .Config.Labels "com.docker.compose.service"}}' "$container")" = "$service" ] ||
    fail '容器服务标签与 Nexus 团队服务不符。'
actual_project=$(inspect_container '{{index .Config.Labels "com.docker.compose.project"}}' "$container")
case "$actual_project" in
    ''|[!a-z0-9]*|*[!a-z0-9_-]*) fail '无法确认 Compose 项目名。' ;;
esac
[ -z "$project_name" ] || [ "$project_name" = "$actual_project" ] || fail '实际 Compose 项目名不符。'
project_name=$actual_project
actual_directory=$(inspect_container '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container")
[ -n "$actual_directory" ] && [ "$(cd "$actual_directory" && pwd -P)" = "$project_directory" ] ||
    fail '容器所属目录与指定项目目录不符。'
compose_files=$(inspect_container '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$container")
[ "${compose_files%%,*}" = "$compose_file" ] || fail '实际使用的第一个 Compose 文件与指定文件不符。'

with_image() (
    image=$1
    shift
    set -- -f "$override" "$@"
    files=$compose_files
    while :; do
        file=${files##*,}
        [ -f "$file" ] || exit 1
        if [ "$file" != "$override" ]; then
            set -- -f "$file" "$@"
        fi
        case "$files" in
            *,*) files=${files%,*} ;;
            *) break ;;
        esac
    done
    NEXUS_TEAM_UPDATE_IMAGE=$image docker compose --project-directory "$project_directory" --project-name "$project_name" "$@"
)

data_mount() {
    inspect_container '{{range .Mounts}}{{if eq .Destination "/var/lib/nexus"}}{{if and (eq .Type "bind") .RW}}{{println .Source}}{{end}}{{end}}{{end}}' "$1"
}

container_listen() {
    inspect_container '{{range .Config.Cmd}}{{println .}}{{end}}' "$1" |
        awk '/^serve$/ {serve=1; next} serve && !/^--/ {print; exit}'
}

data_directory=$(data_mount "$container")
case "$data_directory" in
    /*) ;;
    *) fail '必须保留原有 /var/lib/nexus 的可写宿主绑定目录。' ;;
esac
[ -d "$data_directory" ] && [ -f "$data_directory/team.sqlite3" ] &&
    [ ! -L "$data_directory/team.sqlite3" ] || fail '原有绑定目录没有可备份的团队数据库。'

listen=$(container_listen "$container")
printf '%s\n' "$listen" |
    awk -F '[.:]' 'NF==5 && $0 ~ /^[0-9.]+:[0-9]+$/ && $1<=255 && $2<=255 && $3<=255 && $4<=255 && $5>0 && $5<=65535 {valid=1} END {exit !valid}' ||
    fail '无法从现有监听命令确认团队服务的 IPv4 地址和端口。'
health_url=http://$listen/v1/info
health_attempts=${NEXUS_TEAM_UPDATE_HEALTH_ATTEMPTS:-30}
case "$health_attempts" in
    ''|*[!0-9]*) fail '健康检查次数应为正整数。' ;;
esac
[ "$health_attempts" -ge 2 ] && [ "$health_attempts" -le 120 ] ||
    fail '健康检查次数须在 2 到 120 之间。'

healthy() {
    [ "$(inspect_container '{{.State.Status}}' "$1")" = running ] &&
        [ "$(curl -q --noproxy '*' --silent --connect-timeout 2 --max-time 4 --output /dev/null --write-out '%{http_code}' "$health_url")" = 401 ]
}

wait_healthy() (
    attempts=0
    consecutive=0
    while [ "$attempts" -lt "$health_attempts" ]; do
        if healthy "$1"; then
            consecutive=$((consecutive + 1))
            [ "$consecutive" -lt 2 ] || exit 0
        else
            consecutive=0
        fi
        attempts=$((attempts + 1))
        [ "$attempts" -ge "$health_attempts" ] || sleep 2
    done
    exit 1
)

valid_image_id() {
    printf '%s\n' "$1" | awk '/^sha256:[0-9a-f]+$/ && length($0)==71 {valid++} END {exit valid!=1 || NR!=1}'
}

original_image=$(inspect_container '{{.Image}}' "$container")
valid_image_id "$original_image" || fail '无法确认原有容器镜像编号。'
healthy "$container" || fail '当前服务未通过健康检查，保留现有部署。'

log "检查 $repository:stable。"
pull_log=$(docker pull "$repository:stable") || fail '拉取发布镜像失败。'
digest=$(printf '%s\n' "$pull_log" | awk '$1=="Digest:" && NF==2 {print $2}')
valid_image_id "$digest" || fail '未收到唯一的发布镜像摘要。'
release_image=$repository@$digest
release_id=$(docker image inspect --format '{{.Id}}' "$release_image") || fail '无法读取已拉取的固定摘要镜像。'
valid_image_id "$release_id" || fail '发布镜像编号无效。'
if [ "$release_id" = "$original_image" ]; then
    log '团队服务已运行当前版本。'
    exit 0
fi

original_config_image=$(inspect_container '{{.Config.Image}}' "$container")
with_image "$release_image" config -q || fail '更新覆盖与现有 Compose 配置不兼容。'
[ "$(base_compose ps -a -q "$service")" = "$container" ] &&
    healthy "$container" || fail '检查期间服务状态发生变化，请重新运行。'
rollback_image=nexus-team-rollback:$project_name-previous
docker image tag "$original_image" "$rollback_image" || fail '无法保留原有镜像。'

[ ! -L "$state/backups" ] || fail '备份目录位置异常。'
mkdir -p "$state/backups"
backup=$(mktemp -d "$state/backups/$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
archive=$backup/team.sqlite3.tar.gz
operation_active=0
backup_complete=0

write_current() {
    printf 'NEXUS_TEAM_UPDATE_IMAGE=%s\n' "$1" >"$backup/current.env"
    mv -f "$backup/current.env" "$state/current.env"
}

recreate() (
    image=$1
    expected_id=$2
    with_image "$image" up -d --no-start --no-deps --no-build --pull never --force-recreate "$service" >&2 || exit 1
    candidate=$(with_image "$image" ps -a -q "$service") || exit 1
    single_container "$candidate" || exit 1
    [ "$(inspect_container '{{.Image}}' "$candidate")" = "$expected_id" ] &&
        [ "$(data_mount "$candidate")" = "$data_directory" ] &&
        [ "$(container_listen "$candidate")" = "$listen" ] || exit 1
    docker container start "$candidate" >&2 || exit 1
    printf '%s\n' "$candidate"
)

finish() {
    status=$?
    trap - 0 HUP INT TERM
    if [ "$operation_active" -eq 1 ]; then
        log '更新未完成，正在恢复原镜像。现有数据库文件将保持原状。'
        if [ "$backup_complete" -eq 0 ]; then
            # The replacement has not been created, so restart the same stopped container.
            restored=$container
            docker container start "$restored" >&2 || restored=
        else
            restored=$(recreate "$rollback_image" "$original_image") || restored=
        fi
        if [ -n "$restored" ] && wait_healthy "$restored"; then
            write_current "$rollback_image" || log "回退镜像：$rollback_image。"
            printf 'result=rolled-back\n' >>"$state/blocked" || :
            log '原镜像已恢复运行。自动更新已暂停，请检查失败原因。'
        else
            if [ -n "$restored" ]; then
                docker container stop --time 60 "$restored" >&2 || :
            fi
            printf 'result=rollback-failed\n' >>"$state/blocked" || :
            log '原镜像未通过健康检查。请按状态文件检查 Compose 日志及数据库兼容性。'
        fi
        log "状态记录：$state/blocked。"
        if [ "$backup_complete" -eq 1 ]; then
            log "更新前的 SQLite 备份：$archive。"
        fi
    fi
    exit "$status"
}

trap finish 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'target=%s\noriginal=%s\nrollback=%s\nbackup=%s\n' "$release_image" "$original_config_image" "$rollback_image" "$archive" >"$state/blocked"
operation_active=1

docker container stop --time 60 "$container" >&2 || fail '停止原有容器失败。'
[ "$(inspect_container '{{.State.Status}}' "$container")" = exited ] || fail '无法确认原数据库已停止写入。'
set -- team.sqlite3
for file in team.sqlite3-wal team.sqlite3-journal; do
    if [ -f "$data_directory/$file" ]; then
        [ ! -L "$data_directory/$file" ] || fail '数据库日志路径异常。'
        set -- "$@" "$file"
    fi
done
tar -C "$data_directory" -czf "$archive.tmp" "$@" || fail '创建 SQLite 备份失败。'
tar -tzf "$archive.tmp" >/dev/null || fail '无法验证 SQLite 备份归档。'
mv "$archive.tmp" "$archive"
backup_complete=1

candidate=$(recreate "$release_image" "$release_id") || fail '新容器镜像、监听方式或数据库绑定不符。'
wait_healthy "$candidate" || fail '新版本没有通过团队服务健康检查。'
write_current "$release_image"
operation_active=0
rm -f "$state/blocked"
log "团队服务已更新：$release_image。备份：$archive。"
