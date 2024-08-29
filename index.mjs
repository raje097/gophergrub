import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import cron from 'node-cron';
import moment from 'moment-timezone';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Use CORS to allow cross-origin requests
app.use(cors());
app.use(bodyParser.json());

const file = path.join(__dirname, 'db.json'); // Use the project directory for the database file
const adapter = new JSONFile(file);
const defaultData = { reviews: [] }; // Define default data
const db = new Low(adapter, defaultData); // Pass both adapter and default data

// Function to initialize the database with default values if it's empty
async function initializeDB() {
  try {
    await db.read();
    if (!db.data) {
      console.log('No data found in DB, setting default values.');
      db.data = defaultData; // Set default data if it doesn't exist
      await db.write();
      console.log('Default data set successfully.');
    } else {
      console.log('DB already initialized with data:', db.data);
    }
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

// Initialize the database and then set up the routes
initializeDB().then(() => {
  console.log('Database initialized successfully.');

  // Endpoint to get reviews for a specific dining hall
  app.get('/reviews/:diningHall', async (req, res) => {
    const diningHall = req.params.diningHall;
    await db.read();
    const reviews = db.data.reviews.filter(review => review.diningHall === diningHall);

    const totalRating = reviews.reduce((acc, review) => acc + Number(review.rating), 0);
    const averageRating = reviews.length ? (totalRating / reviews.length) : 0;

    res.json({ averageRating, reviews });
  });

  // Endpoint to post a new review
  app.post('/reviews', async (req, res) => {
    const { diningHall, rating, comment } = req.body;
    const newReview = { diningHall, rating: Number(rating), comment: comment || '' };
    await db.read();
    db.data.reviews.push(newReview);
    await db.write();
    res.status(201).json(newReview);
  });

  // Endpoint to clear all reviews
  app.delete('/reviews', async (req, res) => {
    await db.read();
    db.data.reviews = [];
    await db.write();
    res.status(204).send();
  });

  // Start the server
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}).catch(error => {
  console.error('Error initializing database:', error);
});

// Schedule task to clear reviews at 12:00 AM Central Time every day
cron.schedule('0 0 * * *', async () => {
  const now = moment().tz('America/Chicago');
  if (now.hour() === 0 && now.minute() === 0) {
    console.log('Clearing reviews at 12:00 AM Central Time');
    await db.read();
    db.data.reviews = [];
    await db.write();
    console.log('Reviews cleared successfully.');
  }
});





