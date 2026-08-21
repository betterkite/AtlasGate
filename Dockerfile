FROM node:24-alpine
RUN apk add --no-cache python3
WORKDIR /app
RUN addgroup -S atlasgate && adduser -S -G atlasgate -h /app atlasgate && mkdir -p /data && chown atlasgate:atlasgate /data
COPY --chown=atlasgate:atlasgate package.json ./
COPY --chown=atlasgate:atlasgate src ./src
COPY --chown=atlasgate:atlasgate web ./web
COPY --chown=atlasgate:atlasgate python ./python
ENV ATLASGATE_HOST=0.0.0.0 ATLASGATE_PORT=4310 ATLASGATE_DB_PATH=/data/atlasgate.db ATLASGATE_DEV_MODE=false ATLASGATE_PYTHON=python3
VOLUME ["/data"]
EXPOSE 4310
USER atlasgate
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 CMD wget -qO- http://127.0.0.1:4310/health >/dev/null || exit 1
CMD ["node", "src/server.js"]
