# syntax=docker/dockerfile:1.7

ARG AI_PROXY_NODE_IMAGE=node:20.19.4-alpine@sha256:df02558528d3d3d0d621f112e232611aecfee7cbc654f6b375765f72bb262799

FROM ${AI_PROXY_NODE_IMAGE} AS base

WORKDIR /opt/excalidraw-ai-proxy

RUN corepack enable \
  && corepack prepare yarn@1.22.22 --activate

FROM base AS build

COPY yarn.lock ./yarn.lock
COPY deploy/ai-proxy/package.json ./package.json
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
  yarn install --frozen-lockfile --non-interactive --ignore-scripts

COPY deploy/ai-proxy/tsconfig.json ./tsconfig.json
COPY deploy/ai-proxy/src ./src
RUN yarn build

FROM base AS runtime

ENV NODE_ENV=production

COPY yarn.lock ./yarn.lock
COPY deploy/ai-proxy/package.json ./package.json
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
  yarn install --frozen-lockfile --production=true --non-interactive --ignore-scripts \
  && yarn cache clean

COPY --from=build --chown=node:node /opt/excalidraw-ai-proxy/dist ./dist
# The one-shot migration command runs from the same immutable image as the
# gateway. Keep the SQL beside the runtime artifact instead of relying on a
# host bind mount that could drift from the image being deployed.
COPY --chown=node:node deploy/ai-proxy/migrations ./migrations

USER node
EXPOSE 3016

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http=require('node:http');const request=http.get('http://127.0.0.1:3016/healthz',(response)=>process.exit(response.statusCode===200?0:1));request.setTimeout(3000,()=>{request.destroy();process.exit(1)});request.on('error',()=>process.exit(1));"

CMD ["node", "dist/server.js"]
