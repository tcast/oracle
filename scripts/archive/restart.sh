#!/bin/bash\necho "Killing all Node.js processes..."\nkillall node || true\necho "Clearing port 3000..."\nlsof -ti:3000 | xargs kill -9 || true\necho "Restarting application..."\nnpm run dev
