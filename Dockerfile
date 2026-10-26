# One image for the API (serves the built frontend too) and the scheduled
# jobs (`node Worker/Job.js <command>`) and the migration job.

FROM node:24-slim AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim AS backend-deps
WORKDIR /app
COPY Backend/package.json Backend/package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim
ENV NODE_ENV=production FRONTEND_DIR=/app/public PORT=3001
WORKDIR /app
COPY --from=backend-deps /app/node_modules ./node_modules
COPY Backend/package.json ./
COPY Backend/API ./API
COPY Backend/Database ./Database
COPY Backend/Services ./Services
COPY Backend/Worker ./Worker
COPY --from=frontend /build/dist ./public
USER node
EXPOSE 3001
CMD ["node", "API/Server.js"]
