# Use Node.js 24 on a lightweight Debian image
FROM node:24-bookworm-slim

# Set the working directory inside the container
WORKDIR /app

# Copy dependency definitions first
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application source code
COPY --chown=node:node server.js db.js ./

# Set runtime environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Document the port used by the application
EXPOSE 3000

# Run as a non-root user
USER node

# Start the application
HEALTHCHECK --interval=10s --timeout=3s --retries=3 --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server.js"]
