# Build from the repository root: docker build -f sandbox/Dockerfile -t thu-campus-sandbox-python:1.4.0 .
# Image preparation may access the network. SandboxRunner never pulls/builds at execution time.
FROM ghcr.io/astral-sh/uv:0.9.9 AS uv
FROM python:3.12.12-slim-bookworm

COPY --from=uv /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/matplotlib \
    XDG_CACHE_HOME=/tmp/cache \
    HOME=/tmp \
    PATH=/opt/venv/bin:$PATH
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-dejavu-core libgomp1 \
    && rm -rf /var/lib/apt/lists/*
# 依赖安装走 requirements.txt：它由 requirements.in 编译而来，逐条锁定完整传递依赖并带 sha256。
#   --only-binary :all:  禁止源码分发包，任何 setup.py 都不会在构建期执行；
#   --require-hashes     强制校验每个 wheel 的哈希，索引被投毒或版本漂移会让构建直接失败。
# 锁文件只含 linux/amd64 + CPython 3.12 的 wheel，与基础镜像一致；换基础镜像必须重新编译。
COPY sandbox/requirements.txt /opt/sandbox/requirements.txt
RUN uv venv --python /usr/local/bin/python /opt/venv \
    && uv pip install --python /opt/venv/bin/python --no-cache \
        --require-hashes --only-binary :all: \
        -r /opt/sandbox/requirements.txt \
    && install -d -o 65532 -g 65532 -m 0755 /workspace
WORKDIR /workspace
USER 65532:65532
ENTRYPOINT ["/opt/venv/bin/python"]