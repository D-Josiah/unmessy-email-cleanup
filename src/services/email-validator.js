import { createClient } from '@supabase/supabase-js';

export class EmailValidationService {
  constructor(config) {
    this.config = config;
    
    // Initialize Supabase
    this.supabase = null;
    this.supabaseEnabled = !!(config.supabase && 
                             config.supabase.url && 
                             config.supabase.key &&
                             config.useSupabase !== false);
    
    // Timeouts configuration with defaults - shorter timeouts to prevent HubSpot flow hanging
    this.timeouts = {
      supabase: config.timeouts?.supabase || 1500,
      zeroBounce: config.timeouts?.zeroBounce || 3000,
      hubspot: config.timeouts?.hubspot || 5000,
      validation: config.timeouts?.validation || 4000, 
      webhook: config.timeouts?.webhook || 6000
    };

    // Initialize Supabase client
    if (this.supabaseEnabled) {
      try {
        console.log('SUPABASE_INIT: Initializing Supabase client');
        this.supabase = createClient(
          config.supabase.url,
          config.supabase.key
        );
        
        // Test connection in background without blocking
        this._testSupabaseConnectionAsync();
      } catch (error) {
        console.error('SUPABASE_INIT_ERROR:', { message: error.message });
        // Still keep Supabase enabled for future attempts
      }
    }
    
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
    
    // Extended list of common domains for local validation
    this.commonValidDomains = [
      'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 
      'aol.com', 'protonmail.com', 'fastmail.com', 'mail.com', 'zoho.com',
      'yandex.com', 'gmx.com', 'live.com', 'msn.com', 'me.com', 'mac.com', 
      'googlemail.com', 'pm.me', 'tutanota.com', 'mailbox.org'
    ];
    
    // Client ID for um_check_id generation
    this.clientId = config.clientId || '00001';
    this.umessyVersion = config.umessyVersion || '100';
  }

  // Asynchronous test without blocking operations
  async _testSupabaseConnectionAsync() {
    if (!this.supabase) return;
    
    try {
      // Try a simple query to test the connection - don't use withTimeout here since it's a non-blocking test
      const { data, error } = await this.supabase
        .from('contacts')
        .select('id')
        .limit(1);
        
      if (error) {
        throw error;
      }
      
      console.log('SUPABASE_CONNECTION_TEST: Test query successful');
    } catch (error) {
      console.error('SUPABASE_CONNECTION_TEST_FAILED:', { message: error.message });
      // Non-blocking - just log the error
    }
  }

  // Generic timeout wrapper with AbortController
  async withTimeout(promiseFn, timeoutMs, errorMessage = 'Operation timeout') {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      // Execute the function with the abort signal
      const result = await promiseFn(controller.signal);
      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(errorMessage);
      }
      throw error;
    }
  }
  
  // Generate um_check_id based on specification
  generateUmCheckId() {
    const epochTime = Math.floor(Date.now() / 1000);
    const lastSixDigits = String(epochTime).slice(-6);
    
    // Calculate check digit
    const firstThreeDigits = String(epochTime).slice(0, 3);
    const sum = [...firstThreeDigits].reduce((acc, digit) => acc + parseInt(digit), 0);
    const checkDigit = String(sum * parseInt(this.clientId)).padStart(3, '0');
    
    // Format: lastSixDigits + clientId + checkDigit + version
    return `${lastSixDigits}${this.clientId}${checkDigit}${this.umessyVersion}`;
  }
  
  // Non-blocking Supabase check - doesn't throw, returns default result on failure
  async isKnownValidEmail(email) {
    if (!this.supabaseEnabled || !this.supabase) {
      console.log('SUPABASE_CHECK: Supabase not enabled, skipping check');
      return { found: false };
    }

    try {
      // Use AbortController and timeout
      return await this.withTimeout(
        async (signal) => {
          console.log('SUPABASE_CHECK: Attempting to check if email exists in Supabase', { email });
          
          const { data, error } = await this.supabase
            .from('email_validations')
            .select('email, um_email_status, um_bounce_status, date_last_um_check, date_last_um_check_epoch, um_check_id')
            .eq('email', email)
            .maybeSingle(); // Use maybeSingle to avoid errors for no results
          
          if (error) {
            console.error('SUPABASE_QUERY_ERROR:', { message: error.message, email });
            return { found: false };
          }
          
          const found = !!data;
          console.log('SUPABASE_CHECK: Completed successfully', { 
            email, 
            found, 
            status: data?.um_email_status || null
          });
          
          return {
            found,
            data
          };
        },
        this.timeouts.supabase,
        'Supabase check timeout'
      );
    } catch (error) {
      console.error('SUPABASE_GET_ERROR:', { message: error.message, email });
      return { found: false }; // Continue validation on failure
    }
  }
  
  // Create a contact record with proper error handling and fallback
  async createContact() {
    if (!this.supabaseEnabled || !this.supabase) {
      console.log('SUPABASE_CREATE_CONTACT: Supabase not enabled, returning dummy ID');
      return { id: -1, created: false };
    }
    
    try {
      // Simple approach without using AbortController since this is a critical operation
      console.log('SUPABASE_CREATE_CONTACT: Creating new contact');
      
      const { data, error } = await this.supabase
        .from('contacts')
        .insert({})
        .select('id')
        .single();
      
      if (error) {
        console.error('SUPABASE_CREATE_CONTACT_ERROR:', { message: error.message });
        return { id: -1, created: false };
      }
      
      console.log('SUPABASE_CREATE_CONTACT: Successfully created contact', { id: data.id });
      return { id: data.id, created: true };
    } catch (error) {
      console.error('SUPABASE_CREATE_CONTACT_ERROR:', { message: error.message });
      return { id: -1, created: false };
    }
  }
  
  // Save validation result to Supabase with improved error handling and no AbortController for critical operations
  async saveValidationResult(originalEmail, validationResult) {
    if (!this.supabaseEnabled || !this.supabase) {
      console.log('SUPABASE_SAVE: Supabase not enabled, skipping save');
      return { success: false, reason: 'supabase_disabled' };
    }

    try {
      // Create a check ID for this validation
      const umCheckId = validationResult.um_check_id || this.generateUmCheckId();
      const now = new Date();
      
      // Map validation status to um_email_status and um_bounce_status if not already set
      let umEmailStatus = validationResult.um_email_status || 'Unable to change';
      let umBounceStatus = validationResult.um_bounce_status || 'Unknown';
      
      if (!validationResult.um_email_status) {
        if (validationResult.wasCorrected) {
          umEmailStatus = 'Changed';
        } else {
          umEmailStatus = 'Unchanged';
        }
      }
      
      if (!validationResult.um_bounce_status) {
        if (validationResult.status === 'valid') {
          umBounceStatus = 'Unlikely to bounce';
        } else if (validationResult.status === 'invalid') {
          umBounceStatus = 'Likely to bounce';
        }
      }
      
      // First, look for existing contact with this email - without AbortController
      console.log('SUPABASE_SAVE: Looking for existing validation record', { email: originalEmail });
      const { data: existingValidation, error: validationLookupError } = await this.supabase
        .from('email_validations')
        .select('id, contact_id')
        .eq('email', originalEmail)
        .maybeSingle();
      
      let contactId;
      
      if (existingValidation) {
        console.log('SUPABASE_SAVE: Found existing validation record', { 
          id: existingValidation.id, 
          contactId: existingValidation.contact_id 
        });
        contactId = existingValidation.contact_id;
      } else {
        // Create a new contact
        console.log('SUPABASE_SAVE: No existing validation record found, creating new contact');
        const contactResult = await this.createContact();
        
        if (!contactResult.created) {
          return { 
            success: false, 
            error: 'Failed to create contact record',
            reason: 'contact_creation_failed'
          };
        }
        
        contactId = contactResult.id;
        console.log('SUPABASE_SAVE: Created new contact', { contactId });
      }
      
      // Prepare validation data
      const validationData = {
        contact_id: contactId,
        date_last_um_check: validationResult.date_last_um_check || now.toISOString(),
        date_last_um_check_epoch: validationResult.date_last_um_check_epoch || Math.floor(now.getTime() / 1000),
        um_check_id: umCheckId,
        um_email: validationResult.currentEmail || validationResult.um_email || originalEmail,
        email: originalEmail,
        um_email_status: umEmailStatus,
        um_bounce_status: umBounceStatus
      };
      
      console.log('SUPABASE_SAVE: Prepared validation data', { 
        email: originalEmail, 
        contactId,
        umCheckId
      });
      
      let result;
      
      if (existingValidation) {
        // Update existing record without AbortController
        console.log('SUPABASE_SAVE: Updating existing validation record', { id: existingValidation.id });
        const { data, error } = await this.supabase
          .from('email_validations')
          .update(validationData)
          .eq('id', existingValidation.id)
          .select();
          
        if (error) {
          console.error('SUPABASE_UPDATE_ERROR:', { message: error.message, id: existingValidation.id });
          return { 
            success: false, 
            error: error.message,
            reason: 'update_failed' 
          };
        }
        
        result = { success: true, operation: 'update', data };
      } else {
        // Insert new record without AbortController
        console.log('SUPABASE_SAVE: Inserting new validation record');
        const { data, error } = await this.supabase
          .from('email_validations')
          .insert(validationData)
          .select();
          
        if (error) {
          console.error('SUPABASE_INSERT_ERROR:', { message: error.message });
          return { 
            success: false, 
            error: error.message,
            reason: 'insert_failed'
          };
        }
        
        result = { success: true, operation: 'insert', data };
      }
      
      console.log('SUPABASE_SAVE: Successfully saved validation result', {
        email: originalEmail,
        operation: result.operation,
        id: result.data?.[0]?.id
      });
      
      return result;
    } catch (error) {
      console.error('SUPABASE_SAVE_ERROR:', { message: error.message, email: originalEmail });
      return { 
        success: false, 
        error: error.message,
        reason: 'exception'
      };
    }
  }
  
  // Basic format validation - fast and synchronous  
  isValidEmailFormat(email) {
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return emailRegex.test(email);
  }
  
  // Typo correction - fast and synchronous
  correctEmailTypos(email) {
    if (!email) {
      return { corrected: false, email };
    }
    
    let corrected = false;
    let cleanedEmail = email.trim().toLowerCase();
    
    // Remove spaces
    const noSpaceEmail = cleanedEmail.replace(/\s/g, '');
    if (noSpaceEmail !== cleanedEmail) {
      cleanedEmail = noSpaceEmail;
      corrected = true;
    }
    
    // Check for domain typos
    const [localPart, domain] = cleanedEmail.split('@');
    
    if (domain && this.domainTypos[domain]) {
      cleanedEmail = `${localPart}@${this.domainTypos[domain]}`;
      corrected = true;
    }
    
    // Handle Gmail aliases
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
  
  // Fast domain check - synchronous
  isValidDomain(email) {
    try {
      const domain = email.split('@')[1];
      if (!domain) return false;
      return this.commonValidDomains.includes(domain);
    } catch (error) {
      return false;
    }
  }
  
  // Fast local validation without external services
  quickValidate(email) {
    // Step 1: Format check
    const formatValid = this.isValidEmailFormat(email);
    if (!formatValid) {
      return {
        originalEmail: email,
        currentEmail: email,
        formatValid: false,
        wasCorrected: false,
        status: 'invalid',
        subStatus: 'bad_format',
        recheckNeeded: false,
        validationSteps: [{ step: 'format_check', passed: false }]
      };
    }
    
    // Step 2: Correct typos
    const { corrected, email: correctedEmail } = this.correctEmailTypos(email);
    
    // Step 3: Domain check
    const domainValid = this.isValidDomain(correctedEmail);
    const status = domainValid ? 'valid' : 'unknown';
    
    // Generate um_check_id
    const umCheckId = this.generateUmCheckId();
    const now = new Date();
    
    // Determine Unmessy statuses
    const umEmailStatus = corrected ? 'Changed' : 'Unchanged';
    const umBounceStatus = domainValid ? 'Unlikely to bounce' : 'Unknown';
    
    return {
      originalEmail: email,
      currentEmail: correctedEmail,
      formatValid: true,
      wasCorrected: corrected,
      domainValid,
      status,
      recheckNeeded: !domainValid,
      validationSteps: [
        { step: 'format_check', passed: true },
        { step: 'typo_correction', applied: corrected, original: email, corrected: correctedEmail },
        { step: 'domain_check', passed: domainValid }
      ],
      // Add unmessy specific fields
      date_last_um_check: now.toISOString(),
      date_last_um_check_epoch: Math.floor(now.getTime() / 1000),
      um_check_id: umCheckId,
      um_email: correctedEmail,
      email: email,
      um_email_status: umEmailStatus,
      um_bounce_status: umBounceStatus
    };
  }
  
  // ZeroBounce check with proper timeout handling and did_you_mean handling
  async checkWithZeroBounce(email) {
    if (!this.config.zeroBounceApiKey || this.config.useZeroBounce === false) {
      console.log('ZEROBOUNCE_CHECK: ZeroBounce not configured or disabled, skipping check');
      return {
        email,
        status: 'check_skipped',
        recheckNeeded: true,
        source: 'configuration'
      };
    }

    try {
      console.log('ZEROBOUNCE_CHECK: Starting validation for email', { email });
      
      const result = await this.withTimeout(
        async (signal) => {
          const url = new URL('https://api.zerobounce.net/v2/validate');
          url.searchParams.append('api_key', this.config.zeroBounceApiKey);
          url.searchParams.append('email', email);
          url.searchParams.append('ip_address', '');
          
          console.log('ZEROBOUNCE_CHECK: Sending request to ZeroBounce API', { 
            email,
            url: url.toString().replace(this.config.zeroBounceApiKey, '[REDACTED]')
          });
          
          const response = await fetch(url.toString(), { signal });
          
          if (!response.ok) {
            throw new Error(`ZeroBounce API error: ${response.status} ${response.statusText}`);
          }
          
          const result = await response.json();
          
          console.log('ZEROBOUNCE_CHECK: Received response from ZeroBounce API', { 
            email,
            status: result.status,
            subStatus: result.sub_status,
            didYouMean: result.did_you_mean || null
          });
          
          // Map ZeroBounce status to our status
          let status, subStatus, recheckNeeded, suggestedEmail = null;
          
          // Generate unmessy fields
          const umCheckId = this.generateUmCheckId();
          const now = new Date();
          
          // Check for "did_you_mean" suggestions
          if (result.did_you_mean) {
            console.log('ZEROBOUNCE_CHECK: Found email suggestion from ZeroBounce', {
              original: email,
              suggested: result.did_you_mean
            });
            suggestedEmail = result.did_you_mean;
          }
          
          // Map status and determine unmessy statuses
          let umEmailStatus = suggestedEmail ? 'Changed' : 'Unchanged';
          let umBounceStatus = 'Unknown';
          
          switch (result.status) {
            case 'valid':
              status = 'valid';
              recheckNeeded = false;
              umBounceStatus = 'Unlikely to bounce';
              break;
            case 'invalid':
              status = 'invalid';
              subStatus = result.sub_status;
              recheckNeeded = false;
              umBounceStatus = 'Likely to bounce';
              break;
            case 'catch-all':
            case 'unknown':
              status = 'unknown';
              recheckNeeded = true;
              break;
            case 'spamtrap':
              status = 'invalid';
              subStatus = 'spamtrap';
              recheckNeeded = false;
              umBounceStatus = 'Likely to bounce';
              break;
            case 'abuse':
              status = 'invalid';
              subStatus = 'abuse';
              recheckNeeded = false;
              umBounceStatus = 'Likely to bounce';
              break;
            default:
              status = 'check_failed';
              recheckNeeded = true;
          }
          
          console.log('ZEROBOUNCE_CHECK: Completed successfully', { 
            email, 
            status, 
            subStatus,
            recheckNeeded,
            suggestedEmail
          });
          
          // If valid, try to save to Supabase in background (don't await)
          if (status === 'valid') {
            this.saveValidationResult(email, {
              currentEmail: suggestedEmail || email,
              wasCorrected: !!suggestedEmail,
              status,
              recheckNeeded
            }).catch(error => {
              console.error('ZEROBOUNCE_SAVE_ERROR:', { message: error.message, email });
            });
          }
          
          return {
            email,
            status,
            subStatus,
            recheckNeeded,
            suggestedEmail,
            source: 'zerobounce',
            details: result,
            // Add unmessy specific fields
            date_last_um_check: now.toISOString(),
            date_last_um_check_epoch: Math.floor(now.getTime() / 1000),
            um_check_id: umCheckId,
            um_email: suggestedEmail || email,
            email: email,
            um_email_status: umEmailStatus,
            um_bounce_status: umBounceStatus
          };
        },
        this.timeouts.zeroBounce,
        'ZeroBounce check timeout'
      );
      
      return result;
    } catch (error) {
      console.error('ZEROBOUNCE_CHECK_ERROR:', { message: error.message, email });
      return {
        email,
        status: 'check_failed',
        recheckNeeded: true,
        source: 'zerobounce',
        error: error.message
      };
    }
  }
  
  // Main validation with proper timeout and graceful fallback
  async validateEmail(email, options = {}) {
    const { skipZeroBounce = false, timeoutMs = this.timeouts.validation, isRetry = false } = options;
    
    console.log('VALIDATION_PROCESS: Starting validation for email', { 
      email, 
      skipZeroBounce, 
      timeoutMs,
      isRetry
    });
    
    // Start with quick validation (synchronous, always works)
    const quickResult = this.quickValidate(email);
    
    // If format is invalid, return immediately
    if (!quickResult.formatValid) {
      console.log('VALIDATION_PROCESS: Invalid format detected, returning quick result');
      return quickResult;
    }
    
    // Set a global timeout for the entire validation process
    try {
      console.log('VALIDATION_PROCESS: Starting advanced validation checks');
      
      const result = await this.withTimeout(
        async () => {
          // Log the process
          console.log('VALIDATION_PROCESS: Running Supabase and ZeroBounce checks in parallel');
          
          // Run Supabase check and ZeroBounce check in parallel
          const [knownValidResult, zeroBounceResult] = await Promise.allSettled([
            this.isKnownValidEmail(quickResult.currentEmail),
            skipZeroBounce ? null : this.checkWithZeroBounce(quickResult.currentEmail)
          ]);
          
          // Start with the quick result and enhance it
          const result = { ...quickResult };
          
          // Add Supabase result if successful
          if (knownValidResult.status === 'fulfilled' && knownValidResult.value.found) {
            console.log('VALIDATION_PROCESS: Email found in Supabase database, checking validity', { 
              email: quickResult.currentEmail 
            });
            
            const validationData = knownValidResult.value.data;
            
            // Update the result with data from the database
            if (validationData) {
              result.isKnownValid = true;
              result.status = validationData.um_bounce_status === 'Unlikely to bounce' ? 'valid' : 'invalid';
              result.recheckNeeded = false;
              
              // Include the stored Supabase data in the result
              Object.assign(result, {
                um_email_status: validationData.um_email_status,
                um_bounce_status: validationData.um_bounce_status,
                date_last_um_check: validationData.date_last_um_check,
                date_last_um_check_epoch: validationData.date_last_um_check_epoch,
                um_check_id: validationData.um_check_id
              });
            }
            
            result.validationSteps.push({ step: 'known_valid_check', passed: true });
            
            // If we already have a recent validation (less than 7 days old), we can return early
            const lastCheckTime = validationData?.date_last_um_check_epoch 
              ? validationData.date_last_um_check_epoch * 1000
              : 0;
              
            if (validationData && Date.now() - lastCheckTime < 7 * 24 * 60 * 60 * 1000) {
              console.log('VALIDATION_PROCESS: Using recent validation from database', {
                email: quickResult.currentEmail,
                lastValidated: new Date(lastCheckTime).toISOString(),
                status: result.status
              });
              return result;
        },
        timeoutMs,
        'Validation timeout'
      );
      
      return result;
    } catch (error) {
      console.error('VALIDATION_TIMEOUT:', { message: error.message, email });
      console.log('VALIDATION_PROCESS: Using quick validation result as fallback due to timeout');
      
      // Save quick result to Supabase without blocking
      this.saveValidationResult(email, quickResult).catch(error => {
        console.error('VALIDATION_SAVE_ERROR:', { message: error.message, email });
      });
      
      // Return quick result on timeout
      return quickResult;
    }
  }
  
  // Batch validation with time budget management
  async validateBatch(emails, options = {}) {
    const { skipZeroBounce = false, timeoutPerEmailMs = 2000 } = options;
    
    const results = [];
    const batchStartTime = Date.now();
    const totalBatchTimeoutMs = Math.min(5000, emails.length * timeoutPerEmailMs);
    
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      
      // Calculate remaining time budget
      const elapsedTime = Date.now() - batchStartTime;
      const remainingTimeMs = totalBatchTimeoutMs - elapsedTime;
      
      // If we're running out of time, use quick validation for remaining emails
      if (remainingTimeMs < timeoutPerEmailMs / 2) {
        // Process remaining emails with quick validation
        for (let j = i; j < emails.length; j++) {
          const quickResult = this.quickValidate(emails[j]);
          results.push(quickResult);
          
          // Save quick results to Supabase in background (don't await)
          this.saveValidationResult(emails[j], quickResult).catch(error => {
            console.error('BATCH_SAVE_ERROR:', { message: error.message, email: emails[j] });
          });
        }
        break;
      }
      
      try {
        // Validate with appropriate timeout
        const result = await this.validateEmail(email, {
          skipZeroBounce,
          timeoutMs: Math.min(remainingTimeMs, timeoutPerEmailMs)
        });
        
        results.push(result);
      } catch (error) {
        console.error('BATCH_VALIDATION_ERROR:', { message: error.message, email });
        // Fall back to quick validation
        const quickResult = this.quickValidate(email);
        results.push(quickResult);
        
        // Save quick result to Supabase in background
        this.saveValidationResult(email, quickResult).catch(error => {
          console.error('BATCH_SAVE_ERROR:', { message: error.message, email });
        });
      }
    }
    
    return results;
  }
  
  // Update HubSpot contact with proper timeout handling
  async updateHubSpotContact(contactId, validationResult) {
    console.log('HUBSPOT_UPDATE: Starting contact update', {
      contactId,
      validationStatus: validationResult.status,
      email: validationResult.currentEmail
    });
    
    if (!this.config.hubspot?.apiKey) {
      console.error('HUBSPOT_UPDATE: API key not configured');
      return {
        success: false,
        contactId,
        error: 'HubSpot API key not configured'
      };
    }

    try {
      console.log('HUBSPOT_UPDATE: Preparing properties for update');
      
      return await this.withTimeout(
        async (signal) => {
          // Prepare properties to update
          const properties = {
            email: validationResult.currentEmail,
            email_status: validationResult.status,
            email_recheck_needed: validationResult.recheckNeeded,
            email_check_date: new Date().toISOString(),
            
            // Include Unmessy specific fields
            um_email_status: validationResult.um_email_status,
            um_bounce_status: validationResult.um_bounce_status,
            date_last_um_check: validationResult.date_last_um_check,
            um_check_id: validationResult.um_check_id
          };
          
          // Add original email if corrected (either by built-in corrections or ZeroBounce suggestion)
          if (validationResult.wasCorrected) {
            properties.original_email = validationResult.originalEmail;
            properties.email_corrected = true;
            
            // If correction was due to ZeroBounce suggestion, add that info
            if (validationResult.validationSteps?.some(step => step.step === 'zerobounce_suggestion')) {
              properties.email_correction_source = 'zerobounce';
              
              const suggestionStep = validationResult.validationSteps?.find(
                step => step.step === 'zerobounce_suggestion'
              );
              
              if (suggestionStep) {
                properties.email_suggested_by_zerobounce = true;
                properties.email_suggestion_original = suggestionStep.original;
              }
            } else {
              properties.email_correction_source = 'internal';
            }
          }
          
          if (validationResult.subStatus) {
            properties.email_sub_status = validationResult.subStatus;
          }
          
          console.log('HUBSPOT_UPDATE: Sending update request', {
            contactId,
            properties: Object.keys(properties).join(', ')
          });
          
          // Send update request
          const response = await fetch(
            `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
            {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.hubspot.apiKey}`
              },
              body: JSON.stringify({ properties }),
              signal
            }
          );
          
          console.log('HUBSPOT_UPDATE: Received response', {
            contactId,
            status: response.status,
            statusText: response.statusText
          });
          
          if (!response.ok) {
            throw new Error(`HubSpot API error: ${response.status} ${response.statusText}`);
          }
          
          const data = await response.json();
          
          console.log('HUBSPOT_UPDATE: Successfully updated contact', {
            contactId,
            responseId: data.id
          });
          
          return {
            success: true,
            contactId,
            hubspotResponse: data
          };
        },
        this.timeouts.hubspot,
        'HubSpot update timeout'
      );
    } catch (error) {
      console.error('HUBSPOT_UPDATE_ERROR:', { message: error.message, contactId });
      return {
        success: false,
        contactId,
        error: error.message
      };
    }
  }
}
            }
          } else {
            console.log('VALIDATION_PROCESS: Email not found in Supabase or check failed', {
              email: quickResult.currentEmail,
              status: knownValidResult.status
            });
            
            result.isKnownValid = false;
            result.validationSteps.push({ 
              step: 'known_valid_check', 
              passed: false, 
              error: knownValidResult.status === 'rejected' ? knownValidResult.reason.message : null 
            });
          }
          
          // Check ZeroBounce result and process any suggested email
          if (!skipZeroBounce && zeroBounceResult?.status === 'fulfilled' && zeroBounceResult.value) {
            const bounceCheck = zeroBounceResult.value;
            
            console.log('VALIDATION_PROCESS: ZeroBounce check completed', {
              email: quickResult.currentEmail,
              status: bounceCheck.status,
              subStatus: bounceCheck.subStatus,
              suggestedEmail: bounceCheck.suggestedEmail
            });
            
            // Check for suggested email from ZeroBounce
            if (bounceCheck.suggestedEmail && !isRetry) {
              console.log('VALIDATION_PROCESS: ZeroBounce suggested an email correction, revalidating', {
                originalEmail: email,
                suggestedEmail: bounceCheck.suggestedEmail
              });
              
              // Recursive call with the suggested email, but mark as a retry to prevent infinite loops
              const suggestedEmailResult = await this.validateEmail(bounceCheck.suggestedEmail, {
                skipZeroBounce: false,  // Always check with ZeroBounce for the suggested email
                timeoutMs: timeoutMs * 0.8,  // Reduce timeout for the retry to ensure we don't exceed the original
                isRetry: true  // Mark this as a retry to prevent infinite loops
              });
              
              // Add information about the suggestion to the result
              suggestedEmailResult.originalEmail = email;
              suggestedEmailResult.wasCorrected = true;
              suggestedEmailResult.validationSteps.push({
                step: 'zerobounce_suggestion',
                original: email,
                suggested: bounceCheck.suggestedEmail,
                result: suggestedEmailResult.status
              });
              
              // Update unmessy fields
              suggestedEmailResult.um_email_status = 'Changed';
              suggestedEmailResult.email = email;
              
              console.log('VALIDATION_PROCESS: Completed validation with ZeroBounce suggestion', {
                originalEmail: email,
                suggestedEmail: bounceCheck.suggestedEmail,
                finalStatus: suggestedEmailResult.status
              });
              
              // Save validation result to Supabase
              this.saveValidationResult(email, suggestedEmailResult).catch(error => {
                console.error('VALIDATION_SAVE_ERROR:', { message: error.message, email });
              });
              
              return suggestedEmailResult;
            }
            
            // Only update if we got a definitive result or no suggested email was available
            if (bounceCheck.status === 'valid' || bounceCheck.status === 'invalid') {
              result.status = bounceCheck.status;
              result.subStatus = bounceCheck.subStatus;
              result.recheckNeeded = bounceCheck.recheckNeeded;
              
              // Update unmessy fields from ZeroBounce results
              result.um_bounce_status = bounceCheck.um_bounce_status;
              result.um_check_id = bounceCheck.um_check_id;
              result.date_last_um_check = bounceCheck.date_last_um_check;
              result.date_last_um_check_epoch = bounceCheck.date_last_um_check_epoch;
            }
            
            result.validationSteps.push({
              step: 'zerobounce_check',
              result: bounceCheck
            });
          } else if (!skipZeroBounce) {
            console.log('VALIDATION_PROCESS: ZeroBounce check failed or was skipped', {
              email: quickResult.currentEmail,
              error: zeroBounceResult?.reason?.message || 'Failed or skipped'
            });
            
            result.validationSteps.push({
              step: 'zerobounce_check',
              error: zeroBounceResult?.reason?.message || 'Failed or skipped'
            });
          }
          
          console.log('VALIDATION_PROCESS: All validation steps completed successfully', {
            email: quickResult.currentEmail,
            finalStatus: result.status,
            recheckNeeded: result.recheckNeeded
          });
          
          // Save validation result to Supabase without blocking
          this.saveValidationResult(email, result).catch(error => {
            console.error('VALIDATION_SAVE_ERROR:', { message: error.message, email });
          });
          
          return result;