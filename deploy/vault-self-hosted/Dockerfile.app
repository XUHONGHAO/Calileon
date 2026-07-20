ARG APP_NODE_IMAGE=node:24@sha256:8530f76a96d88820d288761f022e318970dda93d01536919fbc16076b7983e63
ARG APP_NGINX_IMAGE=nginx:1.28.0-alpine@sha256:30f1c0d78e0ad60901648be663a710bdadf19e4c10ac6782c235200619158284

FROM ${APP_NODE_IMAGE} AS build

WORKDIR /opt/excalidraw

ENV NODE_OPTIONS=--max-old-space-size=4096

ARG VITE_APP_WS_SERVER_URL
ARG VITE_APP_VAULT_ENABLED=false
ARG VITE_APP_VAULT_PERSISTENCE_CAPABILITIES_URL
ARG VITE_APP_VAULT_ROOM_CAPABILITIES_URL
ARG VITE_APP_VAULT_ROOM_PROVISION_URL
ARG VITE_APP_SUPABASE_URL
ARG VITE_APP_SUPABASE_ANON_KEY

ENV VITE_APP_WS_SERVER_URL=${VITE_APP_WS_SERVER_URL}
ENV VITE_APP_VAULT_ENABLED=${VITE_APP_VAULT_ENABLED}
ENV VITE_APP_VAULT_PERSISTENCE_CAPABILITIES_URL=${VITE_APP_VAULT_PERSISTENCE_CAPABILITIES_URL}
ENV VITE_APP_VAULT_ROOM_CAPABILITIES_URL=${VITE_APP_VAULT_ROOM_CAPABILITIES_URL}
ENV VITE_APP_VAULT_ROOM_PROVISION_URL=${VITE_APP_VAULT_ROOM_PROVISION_URL}
ENV VITE_APP_SUPABASE_URL=${VITE_APP_SUPABASE_URL}
ENV VITE_APP_SUPABASE_ANON_KEY=${VITE_APP_SUPABASE_ANON_KEY}
ENV VITE_APP_DISABLE_SENTRY=true
ENV VITE_APP_REMOTE_VIDEO_ASSETS=false
ENV VITE_APP_ENABLE_PWA=false
ENV VITE_APP_SELF_HOSTED=true

COPY . .
RUN --mount=type=cache,target=/root/.cache/yarn \
  yarn --frozen-lockfile --network-timeout 600000
RUN yarn build:app:docker

FROM ${APP_NGINX_IMAGE} AS runtime

COPY deploy/vault-self-hosted/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /opt/excalidraw/excalidraw-app/build /usr/share/nginx/html

RUN mkdir -p /tmp/nginx/client_temp /tmp/nginx/proxy_temp \
  /tmp/nginx/fastcgi_temp /tmp/nginx/uwsgi_temp /tmp/nginx/scgi_temp \
  && chown -R nginx:nginx /tmp/nginx /usr/share/nginx/html

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

CMD ["sh", "-c", "mkdir -p /tmp/nginx/client_temp /tmp/nginx/proxy_temp /tmp/nginx/fastcgi_temp /tmp/nginx/uwsgi_temp /tmp/nginx/scgi_temp && exec nginx -g 'daemon off;'"]
