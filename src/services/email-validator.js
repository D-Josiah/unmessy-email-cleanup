// src/services/email-validator.js
import { createClient } from '@supabase/supabase-js';

export class EmailValidationService {
  constructor(config) {
    this.config = config;
    
    // Status tracking for Supabase connection
    this.supabaseConnectionStatus = 'initializing';
    
    // Detailed logging for initialization
    console.log('EMAIL_VALIDATOR_INIT: Initializing email validation service', {
      useSupabase: config.useSupabase,
      supabaseUrlProvided: !!config.supabase?.url,
      supabaseKeyProvided: !!config.supabase?.key && config.supabase.key.length > 0,
      useZeroBounce: config.useZeroBounce
    });
    
    // Initialize Supabase by checking all required fields
    this.supabase = null;
    this.supabaseEnabled = !!(config.supabase && 
                             config.supabase.url && 
                             config.supabase.url.includes('supabase.co') &&
                             config.supabase.key && 
                             config.supabase.key.length > 0 &&
                             config.useSupabase !== false);
    
    // Log whether Supabase was enabled and why/why not
    if (this.supabaseEnabled) {
      console.log('EMAIL_VALIDATOR_INIT: Supabase storage enabled');
    } else {
      console.log('EMAIL_VALIDATOR_INIT: Supabase storage disabled', {
        reasons: {
          configMissing: !config.supabase,
          urlMissing: !config.supabase?.url,
          urlInvalid: config.supabase?.url && !config.supabase.url.includes('supabase.co'),
          keyMissing: !config.supabase?.key,
          keyInvalid: config.supabase?.key && config.supabase.key.length === 0,
          explicitlyDisabled: config.useSupabase === false
        }
      });
      this.supabaseConnectionStatus = 'disabled';
    }
    
    // Initialize Supabase client if enabled
    if (this.supabaseEnabled) {
      try {
        console.log('EMAIL_VALIDATOR_INIT: Creating Supabase client with provided configuration');
        
        this.supabase = createClient(
          config.supabase.url,
          config.supabase.key,
          {
            auth: { 
              persistSession: false,
              autoRefreshToken: false
            },
            // Add custom fetch with longer timeout
            global: {
              headers: {
                'Content-Type': 'application/json'
              },
              fetch: (...args) => {
                return fetch(...args, {
                  // Increase timeout significantly
                  signal: AbortSignal.timeout(15000) // 15 seconds timeout
                });
              }
            }
          }
        );
        
        console.log('EMAIL_VALIDATOR_INIT: Supabase client created successfully');
        
        // Don't test connection immediately - defer until needed
        this.supabaseConnectionStatus = 'pending';
      } catch (error) {
        console.error('EMAIL_VALIDATOR_INIT_ERROR:', { 
          message: error.message,
          stack: error.stack 
        });
        this.supabaseConnectionStatus = 'error';
      }
    }
    
    // Timeouts configuration with defaults
    this.timeouts = {
      supabase: config.timeouts?.supabase || 8000,
      zeroBounce: config.timeouts?.zeroBounce || 4000,
      hubspot: config.timeouts?.hubspot || 5000,
      validation: config.timeouts?.validation || 4000, 
      webhook: config.timeouts?.webhook || 6000
    };

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
    if (!this.supabase) {
      console.log('SUPABASE_CONNECTION_TEST: No Supabase client initialized');
      this.supabaseConnectionStatus = 'disabled';
      return;
    }
    
    try {
      console.log('SUPABASE_CONNECTION_TEST: Attempting to connect to Supabase...');
      
      // Simpler approach without abort controller for more reliable connection
      try {
        // Make a simple query that's fast - just check if the table exists
        const { data, error } = await this.supabase
          .from('contacts')
          .select('id')
          .limit(1);
        
        if (error) {
          console.error('SUPABASE_CONNECTION_FAILED:', { 
            message: error.message,
            code: error.code,
            details: error.details
          });
          this.supabaseConnectionStatus = 'failed';
          return;
        }
        
        // Connection successful
        console.log('SUPABASE_CONNECTION_SUCCESSFUL: Successfully connected to Supabase database', {
          tableName: 'contacts',
          approximateRowCount: data ? data.length : 0
        });
        this.supabaseConnectionStatus = 'connected';
      } catch (innerError) {
        throw innerError;
      }
    } catch (error) {
      console.error('SUPABASE_CONNECTION_TEST_ERROR:', { 
        message: error.message,
        stack: error.stack
      });
      this.supabaseConnectionStatus = 'error';
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
  generateUmCheckId(customClientId = null) {
    const epochTime = Math.floor(Date.now() / 1000);
    const lastSixDigits = String(epochTime).slice(-6);
    
    // Use provided client ID or default
    const clientId = customClientId || this.clientId;
    
    // Calculate check digit
    const firstThreeDigits = String(epochTime).slice(0, 3);
    const sum = [...firstThreeDigits].reduce((acc, digit) => acc + parseInt(digit), 0);
    const checkDigit = String(sum * parseInt(clientId)).padStart(3, '0');
    
    // Format: lastSixDigits + clientId + checkDigit + version
    return `${lastSixDigits}${clientId}${checkDigit}${this.umessyVersion}`;
  }
  
  // Non-blocking Supabase check - doesn't throw, returns false on failure
  async isKnownValidEmail(email) {
    if (!this.supabaseEnabled || !this.supabase) {
      console.log('SUPABASE_CHECK: Supabase not enabled, skipping check');
      return { found: false };
    }

    try {
      // Use AbortController and timeout
      const result = await this.withTimeout(
        async (signal) => {
          console.log('SUPABASE_CHECK: Attempting to check if email exists in Supabase', { email });
          
          const { data, error } = await this.supabase
            .from('email_validations')
            .select('email, um_email_status')
            .eq('email', email)
            .abortSignal(signal)
            .single();
          
          if (error && error.code !== 'PGRST116') { // PGRST116 is "No rows returned" error
            throw error;
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
      
      if (result.found) {
        console.log('SUPABASE_CHECK: Email found in Supabase database', { email });
      } else {
        console.log('SUPABASE_CHECK: Email not found in Supabase database', { email });
      }
      
      return result;
    } catch (error) {
      console.error('SUPABASE_GET_ERROR:', { message: error.message, email });
      return { found: false }; // Continue validation on failure
    }
  }
  
  // Save validation result to Supabase with improved reliability
  async saveValidationResult(originalEmail, validationResult, clientId = null) {
    if (!this.supabaseEnabled || !this.supabase) {
      console.log('SUPABASE_SAVE: Supabase not enabled, skipping save', {
        supabaseEnabled: this.supabaseEnabled,
        supabaseClientExists: !!this.supabase,
        connectionStatus: this.supabaseConnectionStatus
      });
      return { success: false, reason: 'Supabase not enabled' };
    }

    // First, check our connection status and test if needed
    if (this.supabaseConnectionStatus === 'pending' || this.supabaseConnectionStatus === 'initializing') {
      try {
        console.log('SUPABASE_SAVE: Testing connection before save attempt');
        await this._testSupabaseConnectionAsync();
        
        // If the test succeeded but we still don't have a connected status, wait briefly
        if (this.supabaseConnectionStatus === 'connected') {
          console.log('SUPABASE_SAVE: Connection test successful, proceeding with save');
        } else {
          console.log('SUPABASE_SAVE: Connection test did not result in connected status', {
            status: this.supabaseConnectionStatus
          });
          return { success: false, reason: 'Connection test failed' };
        }
      } catch (error) {
        console.error('SUPABASE_SAVE: Connection test failed', { error: error.message });
        return { success: false, reason: 'Connection test error: ' + error.message };
      }
    }
    
    // Only proceed if we have a confirmed connection
    if (this.supabaseConnectionStatus !== 'connected') {
      console.log('SUPABASE_SAVE: Skipping save due to connection status', {
        connectionStatus: this.supabaseConnectionStatus
      });
      return { success: false, reason: 'Supabase not connected' };
    }

    try {
      console.log('SUPABASE_SAVE: Starting save operation for email', { 
        email: originalEmail,
        clientId: clientId || 'default'
      });
      
      // Create a check ID for this validation if not already present
      const umCheckId = validationResult.um_check_id || this.generateUmCheckId(clientId);
      const now = new Date();
      
      // Map validation status to um_email_status and um_bounce_status
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
      
      // First, create a contact - use a simpler approach to avoid transaction issues
      console.log('SUPABASE_SAVE: Creating new contact');
      let contactId;
      
      try {
        // Direct insert without transaction for better reliability
        const { data: newContact, error: createContactError } = await this.supabase
          .from('contacts')
          .insert({})
          .select('id')
          .single();
          
        if (createContactError) {
          console.error('SUPABASE_SAVE_ERROR: Failed to create contact', {
            error: createContactError.message,
            code: createContactError.code
          });
          throw new Error(`Failed to create contact: ${createContactError.message}`);
        }
        
        contactId = newContact.id;
        console.log('SUPABASE_SAVE: Created new contact', { contactId });
      } catch (contactError) {
        console.error('SUPABASE_SAVE_ERROR: Exception creating contact', { error: contactError.message });
        throw contactError;
      }
      
      // Now insert the email validation record
      const validationData = {
        contact_id: contactId,
        date_last_um_check: validationResult.date_last_um_check || now.toISOString(),
        date_last_um_check_epoch: validationResult.date_last_um_check_epoch || Math.floor(now.getTime() / 1000),
        um_check_id: umCheckId,
        um_email: validationResult.currentEmail || validationResult.um_email || originalEmail,
        email: originalEmail,
        um_email_status: umEmailStatus,
        um_bounce_status: umBounceStatus,
        client_id: clientId || null // Store the client ID that requested this validation
      };
      
      try {
        console.log('SUPABASE_SAVE: Creating new validation record', {
          contactId,
          email: originalEmail,
          umEmail: validationData.um_email,
          clientId: clientId || 'default'
        });
        
        const { data, error } = await this.supabase
          .from('email_validations')
          .insert(validationData)
          .select()
          .single();
          
        if (error) {
          console.error('SUPABASE_SAVE_ERROR: Failed to insert validation record', {
            error: error.message,
            code: error.code
          });
          throw new Error(`Failed to insert validation record: ${error.message}`);
        }
        
        console.log('SUPABASE_SAVE: Successfully saved validation result', {
          email: originalEmail,
          operation: 'insert',
          id: data.id,
          clientId: clientId || 'default'
        });
        
        return { success: true, operation: 'insert', data };
      } catch (validationError) {
        console.error('SUPABASE_SAVE_ERROR: Exception creating validation record', { 
          error: validationError.message 
        });
        throw validationError;
      }
    } catch (error) {
      console.error('SUPABASE_SAVE_ERROR:', { 
        message: error.message, 
        stack: error.stack,
        email: originalEmail 
      });
      return { success: false, error: error.message };
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
  quickValidate(email, clientId = null) {
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
    const umCheckId = this.generateUmCheckId(clientId);
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
  async checkWithZeroBounce(email, clientId = null) {
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
      console.log('ZEROBOUNCE_CHECK: Starting validation for email', { 
        email,
        clientId: clientId || 'default'
      });
      
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
          
          // Generate unmessy fields
          const umCheckId = this.generateUmCheckId(clientId);
          const now = new Date();
          
          // Check for "did_you_mean" suggestions
          let suggestedEmail = null;
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
          let status, subStatus, recheckNeeded;
          
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
            suggestedEmail,
            clientId: clientId || 'default'
          });
          
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
      console.error('ZEROBOUNCE_CHECK_ERROR:', { 
        message: error.message, 
        email,
        clientId: clientId || 'default'
      });
      return {
        email,
        status: 'check_failed',
        recheckNeeded: true,
        source: 'zerobounce',
        error: error.message
      };
    }
  }
  
  // Save data synchronously during the validation process
  // This is a critical change to fix the data saving issue
  async validateEmail(email, options = {}) {
    const { 
      skipZeroBounce = false, 
      timeoutMs = this.timeouts.validation, 
      isRetry = false,
      clientId = null  // New parameter to track which client made the request
    } = options;
    
    console.log('VALIDATION_PROCESS: Starting validation for email', { 
      email, 
      skipZeroBounce, 
      timeoutMs,
      isRetry,
      clientId: clientId || 'default',
      supabaseStatus: this.supabaseConnectionStatus
    });
    
    // Start with quick validation (synchronous, always works)
    const quickResult = this.quickValidate(email, clientId);
    
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
            skipZeroBounce ? null : this.checkWithZeroBounce(quickResult.currentEmail, clientId)
          ]);
          
          // Start with the quick result and enhance it
          const result = { ...quickResult };
          
          // Add Supabase result if successful
          if (knownValidResult.status === 'fulfilled' && knownValidResult.value.found) {
            console.log('VALIDATION_PROCESS: Email found in Supabase database, marking as valid', { 
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
            
            // If we already have a recent validation, we can return early
            if (validationData && Date.now() - (validationData.date_last_um_check_epoch * 1000) < 7 * 24 * 60 * 60 * 1000) {
              return result;
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
              suggestedEmail: bounceCheck.suggestedEmail,
              clientId: clientId || 'default'
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
                isRetry: true,  // Mark this as a retry to prevent infinite loops
                clientId: clientId  // Pass along client ID
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
                finalStatus: suggestedEmailResult.status,
                clientId: clientId || 'default'
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
            recheckNeeded: result.recheckNeeded,
            clientId: clientId || 'default'
          });
          
          // CRITICAL FIX: Save to Supabase synchronously during validation process
          // This ensures the save completes before the function terminates
          if (this.supabaseEnabled) {
            try {
              console.log('VALIDATION_PROCESS: Starting synchronous save to Supabase');
              const saveResult = await this.saveValidationResult(email, result, clientId);
              console.log('VALIDATION_PROCESS: Supabase save completed', { 
                success: saveResult.success,
                operation: saveResult.operation,
                dataId: saveResult.data?.id || 'none',
                clientId: clientId || 'default'
              });
            } catch (saveError) {
              console.error('VALIDATION_PROCESS: Error during synchronous save', {
                error: saveError.message,
                clientId: clientId || 'default'
              });
            }
          }
          
          return result;
        },
        timeoutMs,
        'Validation timeout'
      );
      
      return result;
    } catch (error) {
      console.error('VALIDATION_TIMEOUT:', { 
        message: error.message, 
        email,
        clientId: clientId || 'default'
      });
      console.log('VALIDATION_PROCESS: Using quick validation result as fallback due to timeout');
      
      // Try to save quick result to Supabase synchronously
      if (this.supabaseEnabled) {
        try {
          console.log('VALIDATION_PROCESS: Saving fallback result to Supabase');
          await this.saveValidationResult(email, quickResult, clientId);
        } catch (saveError) {
          console.error('VALIDATION_PROCESS: Error saving fallback result', {
            error: saveError.message,
            clientId: clientId || 'default'
          });
        }
      }
      
      // Return quick result on timeout
      return quickResult;
    }
  }
  
  // Batch validation with time budget management
  async validateBatch(emails, options = {}) {
    const { 
      skipZeroBounce = false, 
      timeoutPerEmailMs = 2000,
      clientId = null  // New parameter to track which client made the request
    } = options;
    
    console.log('BATCH_VALIDATION: Starting batch validation', { 
      batchSize: emails.length,
      clientId: clientId || 'default'
    });
    
    const results = [];
    const batchStartTime = Date.now();
    const totalBatchTimeoutMs = Math.min(9000, emails.length * timeoutPerEmailMs);
    
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      
      // Calculate remaining time budget
      const elapsedTime = Date.now() - batchStartTime;
      const remainingTimeMs = totalBatchTimeoutMs - elapsedTime;
      
      // If we're running out of time, use quick validation for remaining emails
      if (remainingTimeMs < timeoutPerEmailMs / 2) {
        console.log('BATCH_VALIDATION: Running out of time, using quick validation for remaining emails', {
          processed: i,
          remaining: emails.length - i,
          remainingTimeMs
        });
        
        // Process remaining emails with quick validation
        for (let j = i; j < emails.length; j++) {
          results.push(this.quickValidate(emails[j], clientId));
        }
        break;
      }
      
      try {
        // Validate with appropriate timeout
        const result = await this.validateEmail(email, {
          skipZeroBounce,
          timeoutMs: Math.min(remainingTimeMs, timeoutPerEmailMs),
          clientId
        });
        
        results.push(result);
      } catch (error) {
        console.error('BATCH_VALIDATION_ERROR:', {
          email,
          error: error.message,
          clientId: clientId || 'default'
        });
        
        // Fall back to quick validation
        results.push(this.quickValidate(email, clientId));
      }
    }
    
    console.log('BATCH_VALIDATION: Completed batch validation', {
      batchSize: emails.length,
      resultsCount: results.length,
      clientId: clientId || 'default'
    });
    
    return results;
  }
  
  // Update HubSpot contact with proper timeout handling
  async updateHubSpotContact(contactId, validationResult, clientId = null) {
    console.log('HUBSPOT_UPDATE: Starting contact update', {
      contactId,
      validationStatus: validationResult.status,
      email: validationResult.currentEmail,
      clientId: clientId || 'default'
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
            um_check_id: validationResult.um_check_id,
            
            // Add client ID that performed the validation
            validation_client_id: clientId || this.clientId
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
            properties: Object.keys(properties).join(', '),
            clientId: clientId || 'default'
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
            responseId: data.id,
            clientId: clientId || 'default'
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
      console.error('HUBSPOT_UPDATE_ERROR:', { 
        message: error.message, 
        contactId,
        clientId: clientId || 'default'
      });
      return {
        success: false,
        contactId,
        error: error.message
      };
    }
  }
}