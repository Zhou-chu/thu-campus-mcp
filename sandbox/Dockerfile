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
COPY sandbox/requirements.txt /opt/sandbox/requirements.txt
RUN uv venv --python /usr/local/bin/python /opt/venv \
    && uv pip install --python /opt/venv/bin/python --no-cache -r /opt/sandbox/requirements.txt \
    && mkdir /workspace \
    && chmod 1777 /workspace
WORKDIR /workspace
USER 65532:65532
ENTRYPOINT ["/opt/venv/bin/python"]
