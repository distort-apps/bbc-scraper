const { chromium } = require('playwright');
const fs = require('fs');
const { Client } = require('pg');
const cuid = require('cuid');
require('dotenv').config();

// Function to process the body content and append resource link
const processBody = (paragraphs, link, resource = 'BBC News') => {
  let formattedBody = paragraphs.map(p => `<p>${p}</p>`).join('');
  formattedBody += `<br><br><ul><li><a href='${link}'>Visit ${resource}</a></li></ul>`;
  return formattedBody;
};

// Function to extract the main image from the page
const extractMainImage = async (page) => {
  try {
    const mediaSelector = 'img';
    return await page.$eval(mediaSelector, img => img.src);
  } catch (error) {
    console.error('Error extracting main image:', error);
    return 'https://news.bbc.co.uk/nol/shared/img/bbc_news_120x60.gif'; // Default image
  }
};

// Function to extract any media (image or video thumbnail)
const extractMedia = async (page) => {
  try {
    let mediaUrl = await page.$eval('img.p_holding_image', img => img.src);
    if (!mediaUrl) {
      mediaUrl = await page.$eval('video', video => video.getAttribute('poster') || video.querySelector('img')?.src);
    }
    if (!mediaUrl) {
      mediaUrl = 'https://news.bbc.co.uk/nol/shared/img/bbc_news_120x60.gif'; // Default image
    }
    return mediaUrl;
  } catch (error) {
    console.error('Error extracting media:', error);
    return 'https://news.bbc.co.uk/nol/shared/img/bbc_news_120x60.gif'; // Default image
  }
};

// Function to generate a unique slug based on headline and link
const generateSlug = (headline, link) => {
  const baseSlug = headline.split(' ').slice(0, 3).join('').toLowerCase().replace(/[^a-z]/g, '');
  const uniquePart = Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(-5);
  return `${baseSlug}-${uniquePart}`;
};

(async () => {
  const client = new Client({
    connectionString: process.env.POSTGRES_CONNECTION_STRING,
  });

  console.log('Connecting to the database...');
  try {
    await client.connect();
    console.log('Connected to the database successfully.');

    // Clear old articles from the database
    await client.query('DELETE FROM "Article" WHERE resource = $1', ['BBC News']);
    console.log('Truncated existing articles with resource "BBC News".');

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    console.log('Navigating to BBC News website...');
    try {
      await page.goto('https://www.bbc.com/news', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      console.log('Page loaded successfully');
    } catch (error) {
      console.error('Failed to load BBC News homepage:', error);
      await browser.close();
      await client.end();
      return;
    }

    console.log('Searching for articles...');
    const articles = await page.$$eval(
      'div[data-testid^="london-card"], div[data-testid^="undefined-grid"] div[data-testid^="edinburgh-card"] a[data-testid="internal-link"], div[data-testid^="undefined-grid"] div[data-testid^="london-article"] a[data-testid="internal-link"]',
      items => 
        items.map(item => {
          const headlineElement = item.querySelector('h2[data-testid="card-headline"]');
          const linkElement = item.getAttribute('href');

          if (headlineElement && linkElement) {
            const headline = headlineElement.innerText.trim();
            const link = 'https://www.bbc.com' + linkElement.trim();
            return { headline, link };
          }

          return null; // Filter out null values later
        }).filter(article => article !== null)
    );

    if (articles.length === 0) {
      console.log('No articles found.');
      await browser.close();
      await client.end();
      return;
    }

    const articlesWithSlugs = articles.map(article => ({
      ...article,
      slug: generateSlug(article.headline, article.link),
    }));

    console.log('Collected headlines and links:', articlesWithSlugs);

    for (const article of articlesWithSlugs) {
      console.log(`Visiting article: ${article.headline}`);

      let success = false;
      let attempts = 0;
      const maxAttempts = 3;

      while (!success && attempts < maxAttempts) {
        attempts++;
        try {
          await page.goto(article.link, {
            waitUntil: 'domcontentloaded',
            timeout: 10000,
          });

          // Extract the article body content
          try {
            const paragraphs = await page.$$eval('div[data-component="text-block"] p', paragraphs =>
              paragraphs.map(p => p.innerText.trim())
            );
            article.body = processBody(paragraphs, article.link);
            article.summary = paragraphs.join(' ').split(' ').slice(0, 25).join(' ') + '...';
          } catch (err) {
            console.error('Error finding body content: ', err);
            article.body = '';
            article.summary = '';
          }

          // Extract the author of the article
          try {
            article.author = await page.$eval('div > span.sc-2b5e3b35-7.bZCrck', el => el.innerText.trim());
        } catch (err) {
            console.error('Error finding author: ', err);
            article.author = 'See article for deatails'; // Default author if not found
        }
        

          // Extract the media content (image/video)
          try {
            article.media = await extractMainImage(page);
          } catch (err) {
            console.error('Error finding media: ', err);
            article.media = 'https://news.bbc.co.uk/nol/shared/img/bbc_news_120x60.gif'; // Default image
          }

          // Set the resource, ID, and other metadata
          article.resource = 'BBC News';
          article.id = cuid();
          article.date = new Date().toISOString();

          // Insert the article into the database
          await client.query(
            `INSERT INTO "Article" (id, slug, headline, summary, body, author, resource, media, link, date) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              article.id,
              article.slug,
              article.headline,
              article.summary || '',
              article.body || '',
              article.author,
              article.resource,
              article.media,
              article.link,
              article.date,
            ]
          );

          success = true;
          console.log(`Collected and saved data for article: ${article.headline}`);
        } catch (error) {
          console.error(`Error processing article: ${article.headline}, attempt ${attempts}`, error);
          if (attempts >= maxAttempts) {
            console.error(`Failed to load article after ${maxAttempts} attempts.`);
          }
        }
      }
    }

    // Save all articles to a JSON file
    fs.writeFileSync('bbc-articles.json', JSON.stringify(articlesWithSlugs, null, 2));
    await browser.close();
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
    console.log('Database connection closed.');
  }
})();
