# Reconstruction service with headless Blender 4.5 LTS.
# Build from the repository root:
#   docker build -f reconstruction/service/Dockerfile -t tadaima-reconstruction .
FROM python:3.12-slim-bookworm

ARG BLENDER_VERSION=4.5.14
ARG BLENDER_SHA256=9ba871ff2ecd36526b77432745980b7e6664ecd0c7ca11c48849073dcfe06da3

# Shared libraries Blender links against even in --background mode.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
      libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxext6 libxkbcommon0 \
      libsm6 libice6 libgl1 libegl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/blender.tar.xz \
      "https://download.blender.org/release/Blender${BLENDER_VERSION%.*}/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
 && echo "${BLENDER_SHA256}  /tmp/blender.tar.xz" | sha256sum -c - \
 && mkdir /opt/blender \
 && tar -xJf /tmp/blender.tar.xz -C /opt/blender --strip-components=1 \
 && rm /tmp/blender.tar.xz \
 && /opt/blender/blender --version | head -1

WORKDIR /app
COPY reconstruction/service/requirements.txt reconstruction/service/requirements.txt
RUN pip install --no-cache-dir -r reconstruction/service/requirements.txt

# Blender shading reads the bundled CC0 room textures from public/materials/room.
COPY public/materials/room public/materials/room
COPY reconstruction reconstruction

RUN useradd --system --uid 10001 --home-dir /app tadaima \
 && mkdir -p /data && chown tadaima /data
USER tadaima

ENV BLENDER_BIN=/opt/blender/blender \
    TADAIMA_DATA_DIR=/data \
    PYTHONUNBUFFERED=1 \
    PORT=8000
EXPOSE 8000
# No VOLUME: Railway bans it. Mount a volume at /data (docker run -v, or a Railway volume).
CMD ["python", "-m", "reconstruction.service"]
