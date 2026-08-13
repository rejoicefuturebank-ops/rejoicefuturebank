// Update the CORS configuration to accept your frontend domain
const allowedOrigins = [
    'http://localhost:5500',
    'http://localhost:3000',
    'https://your-frontend-domain.com',
    'https://your-frontend.vercel.app',
    'https://your-frontend.netlify.app'
];

app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy does not allow access from this origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));