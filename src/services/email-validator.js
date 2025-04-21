import { Redis } from '@upstash/redis';

export class EmailValidationService {
  constructor(config) {
    this.config = config;
    
    // Initialize Upstash Redis client
    this.redis = new Redis({
      url: config.upstash.url,
      token: config.upstash.token,
    });
    
    // Common email domain typos
    this.domainTypos = {
      'gmial.com': 'gmail.com',
      'gmal.com': 'gmail.com',
      'gmail.cm': 'gmail.com',
      'gmail.co': 'gmail.com',
      'gamil.com': 'gmail.com',
      'hotmial.com': 'hotmail.com',
      'hotmail.cm': 'hotmail.com',
      'yahoo.cm': 'yahoo.com',
      'yaho.com': 'yahoo.com',
      'outlook.cm': 'outlook.com',
      'outlok.com': 'outlook.com'
    };
    
    this.australianTlds = ['.com.au', '.net.au', '.org.au', '.edu.au', '.gov.au', '.asn.au', '.id.au', '.au'];
    this.commonValidDomains = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'aol.com'];
  }
  
  // Add email to Redis store
  async addToKnownValidEmails(email) {
    try {
      const key = `email:${email}`;
      const data = {
        validatedAt: new Date().toISOString(),
        source: 'validation-service'
      };
      
      // Store in Redis with 30 day expiration (in seconds)
      await this.redis.set(key, JSON.stringify(data), { ex: 30 * 24 * 60 * 60 });
      
      return true;
    } catch (error) {
      console.error('Error storing email in Redis:', error);
      return false;
    }
  }
  
  // Check if email exists in Redis store
  async isKnownValidEmail(email) {
    try {
      const key = `email:${email}`;
      const result = await this.redis.get(key);
      return !!result;
    } catch (error) {
      console.error('Error checking Redis for email:', error);
      return false;
    }
  }
  
  // Basic email format check with regex
  isValidEmailFormat(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }
  
  // Clean and correct common email typos
  correctEmailTypos(email) {
    if (!email) return { corrected: false, email };
    
    let corrected = false;
    let cleanedEmail = email.trim().toLowerCase();
    
    // Remove any spaces
    const noSpaceEmail = cleanedEmail.replace(/\s/g, '');
    if (noSpaceEmail !== cleanedEmail) {
      cleanedEmail = noSpaceEmail;
      corrected = true;
    }
    
    // Check for common domain typos
    const [localPart, domain] = cleanedEmail.split('@');
    
    if (domain && this.domainTypos[domain]) {
      cleanedEmail = `${localPart}@${this.domainTypos[domain]}`;
      corrected = true;
    }
    
    // Check for + alias in Gmail
    if (this.config.removeGmailAliases && domain === 'gmail.com' && localPart.includes('+')) {
      const baseLocal = localPart.split('+')[0];
      cleanedEmail = `${baseLocal}@gmail.com`;
      corrected = true;
    }
    
    // Check Australian TLDs
    if (this.config.checkAustralianTlds) {
      for (const tld of this.australianTlds) {
        const tldNoDot = tld.replace(/\./g, '');
        if (domain && domain.endsWith(tldNoDot) && !domain.endsWith(tld)) {
          const index = domain.lastIndexOf(tldNoDot);
          const newDomain = domain.substring(0, index) + tld;
          cleanedEmail = `${localPart}@${newDomain}`;
          corrected = true;
          break;
        }
      }
    }
    
    return { corrected, email: cleanedEmail };
  }
  
  // Check if email domain is valid
  isValidDomain(email) {
    try {
      const domain = email.split('@')[1];
      return this.commonValidDomains.includes(domain);
    } catch (error) {
      return false;
    }
  }
  
  // Check email with ZeroBounce API
  async checkWithZeroBounce(email) {
    try {
      const url = new URL('https://api.zerobounce.net/v2/validate');
      url.searchParams.append('api_key', this.config.zeroBounceApiKey);
      url.searchParams.append('email', email);
      url.searchParams.append('ip_address', '');
      
      const response = await fetch(url.toString());
      
      if (!response.ok) {
        throw new Error(`ZeroBounce API error: ${response.status} ${response.statusText}`);
      }
      
      const result = await response.json();
      
      // Map ZeroBounce status to our simplified status
      let status, subStatus, recheckNeeded;
      
      switch (result.status) {
        case 'valid':
          status = 'valid';
          recheckNeeded = false;
          break;
        case 'invalid':
          status = 'invalid';
          subStatus = result.sub_status;
          recheckNeeded = false;
          break;
        case 'catch-all':
          status = 'unknown';
          recheckNeeded = true;
          break;
        case 'unknown':
          status = 'unknown';
          recheckNeeded = true;
          break;
        case 'spamtrap':
          status = 'invalid';
          subStatus = 'spamtrap';
          recheckNeeded = false;
          break;
        case 'abuse':
          status = 'invalid';
          subStatus = 'abuse';
          recheckNeeded = false;
          break;
        default:
          status = 'check_failed';
          recheckNeeded = true;
      }
      
      // If valid, add to our known valid emails
      if (status === 'valid') {
        await this.addToKnownValidEmails(email);
      }
      
      return {
        email,
        status,
        subStatus,
        recheckNeeded,
        source: 'zerobounce',
        details: result
      };
      
    } catch (error) {
      console.error('ZeroBounce API error:', error);
      return {
        email,
        status: 'check_failed',
        recheckNeeded: true,
        source: 'zerobounce',
        error: error.message
      };
    }
  }
  
  // Main validation function
  async validateEmail(email) {
    const result = {
      originalEmail: email,
      currentEmail: email,
      formatValid: false,
      wasCorrected: false,
      isKnownValid: false,
      domainValid: false,
      status: 'unknown',
      subStatus: null,
      recheckNeeded: true,
      validationSteps: []
    };
    
    // Step 1: Basic format check with regex
    result.formatValid = this.isValidEmailFormat(email);
    result.validationSteps.push({
      step: 'format_check',
      passed: result.formatValid
    });
    
    if (!result.formatValid) {
      result.status = 'invalid';
      result.subStatus = 'bad_format';
      result.recheckNeeded = false;
      return result;
    }
    
    // Step 2: Correct common typos
    const { corrected, email: correctedEmail } = this.correctEmailTypos(email);
    result.wasCorrected = corrected;
    result.currentEmail = correctedEmail;
    result.validationSteps.push({
      step: 'typo_correction',
      applied: corrected,
      original: email,
      corrected: correctedEmail
    });
    
    // Step 3: Check if it's a known valid email
    result.isKnownValid = await this.isKnownValidEmail(correctedEmail);
    result.validationSteps.push({
      step: 'known_valid_check',
      passed: result.isKnownValid
    });
    
    if (result.isKnownValid) {
      result.status = 'valid';
      result.recheckNeeded = false;
      return result;
    }
    
    // Step 4: Check if domain appears valid
    result.domainValid = this.isValidDomain(correctedEmail);
    result.validationSteps.push({
      step: 'domain_check',
      passed: result.domainValid
    });
    
    // Step 5: If enabled, check with ZeroBounce
    if (this.config.useZeroBounce) {
      const bounceCheck = await this.checkWithZeroBounce(correctedEmail);
      result.status = bounceCheck.status;
      result.subStatus = bounceCheck.subStatus;
      result.recheckNeeded = bounceCheck.recheckNeeded;
      result.validationSteps.push({
        step: 'zerobounce_check',
        result: bounceCheck
      });
    } else {
      // Without ZeroBounce, rely on domain check
      result.status = result.domainValid ? 'unknown' : 'invalid';
      result.recheckNeeded = result.domainValid;
    }
    
    return result;
  }
  
  // Process a batch of emails
  async validateBatch(emails) {
    const results = [];
    
    for (const email of emails) {
      try {
        const result = await this.validateEmail(email);
        results.push(result);
        
        // Add a small delay to avoid rate limits if using ZeroBounce
        if (this.config.useZeroBounce) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      } catch (error) {
        console.error(`Error validating email ${email}:`, error);
        results.push({
          originalEmail: email,
          currentEmail: email,
          status: 'check_failed',
          error: error.message
        });
      }
    }
    
    return results;
  }
  
  // Update HubSpot contact
  async updateHubSpotContact(contactId, validationResult) {
    try {
      if (!this.config.hubspot || !this.config.hubspot.apiKey) {
        throw new Error('HubSpot API key not configured');
      }
      
      const properties = {
        email: validationResult.currentEmail,
        email_status: validationResult.status,
        email_recheck_needed: validationResult.recheckNeeded,
        email_check_date: new Date().toISOString(),
      };
      
      if (validationResult.wasCorrected) {
        properties.original_email = validationResult.originalEmail;
        properties.email_corrected = true;
      }
      
      if (validationResult.subStatus) {
        properties.email_sub_status = validationResult.subStatus;
      }
      
      const response = await fetch(
        `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.hubspot.apiKey}`
          },
          body: JSON.stringify({ properties })
        }
      );
      
      if (!response.ok) {
        throw new Error(`HubSpot API error: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      return {
        success: true,
        contactId,
        hubspotResponse: data
      };
      
    } catch (error) {
      console.error(`Error updating HubSpot contact ${contactId}:`, error);
      return {
        success: false,
        contactId,
        error: error.message
      };
    }
  }
}