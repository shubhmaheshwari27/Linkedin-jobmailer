const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
require("dotenv").config();

puppeteer.use(StealthPlugin());

const scrape = async (io) => {
    try {
        const browser = await puppeteer.launch({ headless: false, args: ["--no-sandbox"] });
        const page = await browser.newPage();

        // Set User-Agent
        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        );

        io.emit('scrape-progress', 'Logging into LinkedIn...');

        // Login to LinkedIn
        await page.goto("https://www.linkedin.com/login", { waitUntil: "networkidle2" });

        // Handle potential redirect if already logged in
        const currentUrl = page.url();
        if (currentUrl.includes("/feed") || currentUrl.includes("/jobs") || currentUrl.includes("/mynetwork")) {
            io.emit('scrape-progress', 'Already logged in. Skipping login step.');
        } else {
            try {
                // Wait for either the username field or handle "Welcome back" screens
                await page.waitForSelector("#username", { timeout: 15000 });
            } catch (e) {
                const urlAtError = page.url();
                const pageTitle = await page.title();

                // Check for "Welcome back" or "Sign in as" screen
                const otherAccountBtn = await page.$(".signin-other-account, button[aria-label='Sign in with a different account'], [data-litms-control-urn='login-submit-alternative']");
                if (otherAccountBtn) {
                    io.emit('scrape-progress', 'Handling "Welcome back" screen...');
                    await otherAccountBtn.click();
                    await page.waitForSelector("#username", { timeout: 10000 });
                } else {
                    // Capture debug info on failure
                    console.log(`[DEBUG] Selector #username not found. URL: ${urlAtError}, Title: ${pageTitle}`);
                    await page.screenshot({ path: "login_error_debug.png" });
                    fs.writeFileSync("login_error_debug.html", await page.content());

                    // Re-throw with more context
                    throw new Error(`LinkedIn login selector (#username) not found. URL: ${urlAtError}. Screenshot saved.`);
                }
            }

            await page.type("#username", process.env.LINKEDIN_EMAIL, { delay: 100 });
            await page.type("#password", process.env.LINKEDIN_PASSWORD, { delay: 100 });

            await page.evaluate(() => {
                const checkbox = document.querySelector('input[name="rememberMeOptIn"]');
                if (checkbox && checkbox.checked) {
                    checkbox.click();
                }
            });

            await page.click("[type='submit']");
            await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 });
        }

        io.emit('scrape-progress', 'Logged in. Starting search...');

        const searchKeyword = process.env.SEARCH_KEYWORD;

        const encodedKeyword = encodeURIComponent(searchKeyword);

        // Search URL
        const searchURL = `https://www.linkedin.com/search/results/content/?keywords=${encodedKeyword}`;

        await page.goto(searchURL, { waitUntil: "networkidle2" });

        io.emit('scrape-progress', 'Scrolling through posts...');

        // Scroll and load more posts
        let previousHeight;
        for (let i = 0; i < process.env.SCROLL_LIMIT; i++) {
            previousHeight = await page.evaluate(() => document.body.scrollHeight);
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
            await new Promise(resolve => setTimeout(resolve, randomDelay(3000, 7000)));
            let newHeight = await page.evaluate(() => document.body.scrollHeight);
            if (newHeight === previousHeight) break;
        }

        io.emit('scrape-progress', 'Extracting posts...');

        // Extract posts
        const posts = await page.evaluate(() => {
            return Array.from(document.querySelectorAll(".feed-shared-update-v2"))
                .map(post => {
                    let content = post.innerText;
                    let emailMatch = content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
                    let hrMatch = content.match(/(HR|Hiring Manager|Recruiter|Talent Acquisition)\s\w+/i);
                    let companyMatch = content.match(/at\s([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/);

                    return {
                        hr_name: hrMatch ? hrMatch[0] : "HR Team",
                        name: "HR Team",
                        company: companyMatch ? companyMatch[1] : null,
                        content: content.substring(0, 500),
                        email: emailMatch ? emailMatch[0] : null
                    };
                })
                .filter(post => post.email !== null);
        });

        io.emit('scrape-progress', `Extracted ${posts.length} posts.`);

        // Save data
        fs.writeFileSync("./data/linkedin_hiring_posts.json", JSON.stringify(posts, null, 2));

        io.emit('scrape-complete', 'Scraping completed and data saved.');
        await browser.close();
    } catch (error) {
        io.emit('scrape-error', `Error during scraping: ${error.message}`);
    }
};

module.exports = { scrape };
