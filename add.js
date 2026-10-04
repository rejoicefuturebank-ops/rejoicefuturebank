const app = express();
app.set('trust proxy', 1); // trust Vercel's proxy layer so req.ip and X-Forwarded-For work correctly