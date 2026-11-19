# Website + API server + admin panel in one image.  docker build -t hitchload .
FROM node:22-alpine AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY admin/package*.json admin/
RUN cd admin && npm install
COPY admin admin
RUN cd admin && npm run build
COPY web/package*.json web/
RUN cd web && npm install
COPY web web
RUN cd web && npm run build
COPY server/package*.json server/
RUN cd server && npm install
COPY server server
RUN cd server && npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/server
COPY --from=build /app/server/node_modules node_modules
COPY --from=build /app/server/dist dist
COPY --from=build /app/server/migrations migrations
COPY --from=build /app/server/package.json .
COPY --from=build /app/admin/dist /app/admin/dist
COPY --from=build /app/web/dist /app/web/dist
EXPOSE 8080
USER node
CMD ["node", "dist/main.js"]
