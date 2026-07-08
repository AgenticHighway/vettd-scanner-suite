# NOTE(vettd-scanner-suite#12): this image is one service in the local
# Compose deployment (compose.yaml). It is NOT yet the deferred single-image
# bundle — that image would additionally vendor this shim into the suite's
# own image instead of running it as a separate container.
#
# Build context is the repo root (see compose.yaml's cisco-shim service),
# so paths below are relative to the repo, not this directory.
FROM python:3.12-slim
WORKDIR /app
COPY shims/cisco/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY shims/cisco/server.py ./
EXPOSE 8787
# No HEALTHCHECK — matches the vettd-shim precedent; the suite adapter's
# available() check covers readiness (an unreachable shim degrades that
# scanner's run to "skipped", not a suite failure).
CMD ["python", "server.py"]
