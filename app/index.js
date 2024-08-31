const { chromium } = require('playwright');
const fs = require('fs');
const { Client } = require('pg');
const cuid = require('cuid');
require('dotenv').config();

const processBody = (body, link, resource = 'BBC News') => {
  let formattedBody = '';

  if (body !== null) {
    formattedBody += `<p>${body}</p><br><br><ul><li><a href='${link}'>Visit ${resource}</a></li></ul>`;
  }

  if (link && !body) {
    formattedBody += `<br><br><ul><li><a href='${link}'>Visit ${resource}</a></li></ul>`;
  } else if (!link && !body) {
    formattedBody = '';
  }

  return formattedBody;
};

(async () => {
  const client = new Client({
    connectionString: process.env.POSTGRES_CONNECTION_STRING,
  });

  console.log('Connecting to the database...');
  try {
    await client.connect();
    console.log('Connected to the database successfully.');

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

      // Handle cookie consent, if necessary
      const cookieButtonSelector = '#bbccookies-continue-button';
      const cookieButtonVisible = await page.isVisible(cookieButtonSelector);

      if (cookieButtonVisible) {
        console.log('Cookie consent banner found, clicking "Continue"...');
        await page.click(cookieButtonSelector);
        console.log('"Continue" button clicked.');
      } else {
        console.log('Cookie consent banner not found.');
      }
    } catch (error) {
      console.error('Failed to load BBC News homepage:', error);
      await browser.close();
      await client.end();
      return;
    }

    console.log('Searching for articles...');
    const articles = await page.$$eval('div[data-testid^="london-card"] a[data-testid="internal-link"]', items =>
      items.map(item => {
        const headline = item.querySelector('h2[data-testid="card-headline"]')?.innerText.trim();
        const link = 'https://www.bbc.com' + item.getAttribute('href').trim();
        const slug = headline.split(' ').slice(0, 3).join('').toLowerCase().replace(/[^a-z]/g, '');
        return { headline, link, slug };
      })
    );

    console.log('Collected headlines and links:', articles);

    for (const article of articles) {
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

          // Extract the main article body content
          try {
            article.body = await page.$eval('article', (el) => {
              // Remove ads, metadata, and other unnecessary elements
              const elementsToRemove = [
                '.advertisement', '.ad-container', '.ad', '.widget', 
                '[role="list"]', 'figcaption', '.ssrcss-1ik71mx-MetadataStripContainer', 
                '.ssrcss-tvuve5-StyledFigureCopyright'
              ];
              elementsToRemove.forEach((selector) => {
                const elements = el.querySelectorAll(selector);
                elements.forEach((element) => element.remove());
              });

              return el.innerText.trim();
            });
          } catch (err) {
            console.error(`Error finding body: `, err);
            article.body = '';
          }

          // Extract summary from the first 25 words of the body
          if (article.body) {
            article.summary = article.body.split(' ').slice(0, 25).join(' ') + '...';
          } else {
            article.summary = '';
          }

          article.body = processBody(article.body, article.link);

          // Extract author, if available
          try {
            article.author = await page.$eval('span.sc-2b5e3b35-7.bZCrck', el => el.innerText.trim());
          } catch (err) {
            console.error(`Error finding author: `, err);
            article.author = 'See article for details';
          }

          // Extract media, if available
          try {
            article.media = await extractMainImage(page);
          } catch (err) {
            console.error(`Error finding media: `, err);
            article.media = 'https://news.bbc.co.uk/nol/shared/img/bbc_news_120x60.gif';
          }

          // Extract publication date, if available
          try {
            const rawDate = await page.$eval('time', el => el.getAttribute('datetime'));
            const date = new Date(rawDate);
            article.date = date.toISOString();
          } catch (err) {
            console.error(`Error finding date: `, err);
            article.date = '';
          }

          article.resource = 'BBC News';
          article.id = cuid();

          // Insert article into the database
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

    fs.writeFileSync('bbc-articles.json', JSON.stringify(articles, null, 2));
    await browser.close();
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
    console.log('Database connection closed.');
  }
})();

async function extractMainImage(page) {
  try {
    const mediaSelector = 'img';
    return await page.$eval(mediaSelector, img => img.src);
  } catch (error) {
    console.error('Error extracting main image:', error);
    return 'https://news.bbc.co.uk/nol/shared/img/bbc_news_120x60.gif';
  }
}
