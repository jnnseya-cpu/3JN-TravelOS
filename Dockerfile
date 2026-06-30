# Backend container — runs the Express API + serves the frontend if you prefer
# a single host. Works on Google Cloud Run, Fly.io, Railway, Render, etc.
FROM node:20-alpine

WORKDIR /app

# Install production deps only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code (backend + shared; frontend is served statically by Express too).
COPY backend ./backend
COPY shared ./shared
COPY frontend ./frontend

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "backend/src/server.js"]
