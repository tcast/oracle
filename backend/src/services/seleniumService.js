const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const pool = require('./db');

class SeleniumService {
  constructor() {
    this.activeDrivers = new Map();
  }

  async createDriver() {
    const options = new chrome.Options();
    options.addArguments('--headless'); // Run in headless mode
    options.addArguments('--no-sandbox');
    options.addArguments('--disable-dev-shm-usage');
    options.addArguments('--disable-notifications');
    options.addArguments('user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    const driver = await new Builder()
      .forBrowser('chrome')
      .setChromeOptions(options)
      .build();

    return driver;
  }

  async redditLogin(driver, username, password) {
    try {
      await driver.get('https://www.reddit.com/login');
      await driver.wait(until.elementLocated(By.name('username')), 10000);
      
      // Login
      await driver.findElement(By.name('username')).sendKeys(username);
      await driver.findElement(By.name('password')).sendKeys(password);
      await driver.findElement(By.css('button[type="submit"]')).click();
      
      // Wait for login to complete
      await driver.wait(until.elementLocated(By.css('header')), 10000);
      
      console.log(`Successfully logged in as ${username}`);
      return true;
    } catch (error) {
      console.error(`Failed to login as ${username}:`, error);
      return false;
    }
  }

  async redditPostComment(driver, postUrl, comment) {
    try {
      await driver.get(postUrl);
      await driver.wait(until.elementLocated(By.css('div[data-test-id="comment-box"]')), 10000);
      
      // Find and click the comment box
      const commentBox = await driver.findElement(By.css('div[data-test-id="comment-box"]'));
      await commentBox.click();
      
      // Type the comment
      await driver.findElement(By.css('div[contenteditable="true"]')).sendKeys(comment);
      
      // Submit the comment
      await driver.findElement(By.css('button[type="submit"]')).click();
      
      // Wait for comment to be posted
      await driver.sleep(2000);
      
      console.log('Comment posted successfully');
      return true;
    } catch (error) {
      console.error('Failed to post comment:', error);
      return false;
    }
  }

  async redditLogout(driver) {
    try {
      // Click user menu
      await driver.findElement(By.css('button[aria-label="Open menu"]')).click();
      await driver.wait(until.elementLocated(By.linkText('Log Out')), 5000);
      
      // Click logout
      await driver.findElement(By.linkText('Log Out')).click();
      await driver.wait(until.elementLocated(By.css('a[href="/login"]')), 5000);
      
      console.log('Successfully logged out');
      return true;
    } catch (error) {
      console.error('Failed to logout:', error);
      return false;
    }
  }

  async postComment(platform, accountId, postUrl, comment) {
    let driver;
    try {
      // Get account credentials
      const accountResult = await this.pool.query(
        'SELECT username, credentials FROM social_accounts WHERE id = $1',
        [accountId]
      );
      
      if (accountResult.rows.length === 0) {
        throw new Error('Account not found');
      }

      const account = accountResult.rows[0];
      const credentials = account.credentials;

      // Create new browser session
      driver = await this.createDriver();
      this.activeDrivers.set(accountId, driver);

      if (platform === 'reddit') {
        // Login
        const loginSuccess = await this.redditLogin(
          driver, 
          account.username,
          credentials.password
        );
        
        if (!loginSuccess) {
          throw new Error('Login failed');
        }

        // Post comment
        const commentSuccess = await this.redditPostComment(driver, postUrl, comment);
        if (!commentSuccess) {
          throw new Error('Failed to post comment');
        }

        // Logout
        await this.redditLogout(driver);
      } else {
        throw new Error('Platform not supported');
      }

      return true;
    } catch (error) {
      console.error('Error in postComment:', error);
      throw error;
    } finally {
      if (driver) {
        await driver.quit();
        this.activeDrivers.delete(accountId);
      }
    }
  }

  async cleanup() {
    // Clean up any remaining browser sessions
    for (const [accountId, driver] of this.activeDrivers) {
      try {
        await driver.quit();
        this.activeDrivers.delete(accountId);
      } catch (error) {
        console.error(`Error cleaning up driver for account ${accountId}:`, error);
      }
    }
  }
}

module.exports = new SeleniumService();
