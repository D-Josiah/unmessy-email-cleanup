// src/services/name-validator.js
export class NameValidationService {
  constructor(config) {
    this.config = config;
    
    // Detailed logging for initialization
    console.log('NAME_VALIDATOR_INIT: Initializing name validation service');
    
    // Initialize hardcoded reference data for name validation
    
    // Common honorifics
    this.honorifics = new Set([
      'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'rev', 'hon', 'sir', 'madam', 
      'lord', 'lady', 'capt', 'major', 'col', 'lt', 'cmdr', 'sgt'
    ]);
    
    // Common name suffixes
    this.suffixes = new Set([
      'jr', 'sr', 'i', 'ii', 'iii', 'iv', 'v', 'phd', 'md', 'dds', 'esq'
    ]);
    
    // Name particles that should not be capitalized conventionally
    this.nameParticles = new Set([
      'von', 'van', 'de', 'del', 'della', 'di', 'da', 'do', 'dos', 'das', 'du', 
      'la', 'le', 'el', 'les', 'lo', 'mac', 'mc', "o'", 'al', 'bin', 'ibn', 
      'ap', 'ben', 'bat', 'bint'
    ]);
    
    // Test/suspicious names
    this.suspiciousNames = new Set([
      'test', 'user', 'admin', 'sample', 'demo', 'fake', 'anonymous', 'unknown', 
      'noreply', 'example', 'null', 'undefined', 'n/a', 'na', 'none', 'blank'
    ]);
    
    // Security patterns to check for
    this.securityPatterns = new Set([
      ');', '--', '/*', '*/', ';', 'drop', 'select', 'insert', 'update', 'delete', 
      'union', 'script', '<>'
    ]);
    
    // Special case name corrections
    this.specialCaseCorrections = new Map([
      ['obrien', "O'Brien"],
      ['oneill', "O'Neill"],
      ['odonnell', "O'Donnell"],
      ['mcdonald', 'McDonald'],
      ['macleod', 'MacLeod'],
      ['vanhalen', 'Van Halen'],
      ['desouza', 'De Souza'],
      ['delafuente', 'De la Fuente']
    ]);
    
    console.log('NAME_VALIDATOR_INIT: Reference data initialized', {
      honorifics: this.honorifics.size,
      suffixes: this.suffixes.size,
      nameParticles: this.nameParticles.size,
      suspiciousNames: this.suspiciousNames.size,
      securityPatterns: this.securityPatterns.size,
      specialCaseCorrections: this.specialCaseCorrections.size
    });
  }
  
  // Helper function to detect script/language and handle character encoding issues
  detectScript(text) {
    if (!text || typeof text !== 'string') return 'unknown';
    
    // Check for character encoding issues
    if (text.includes('�') || /\uFFFD/.test(text)) {
      return 'encoding-issue';
    }
    
    // Check for commonly used scripts
    const scripts = {
      cyrillic: /[\u0400-\u04FF]/,                   // Russian, Ukrainian, etc.
      devanagari: /[\u0900-\u097F]/,                 // Hindi, Sanskrit, etc.
      arabic: /[\u0600-\u06FF\u0750-\u077F]/,        // Arabic, Persian, etc.
      han: /[\u4E00-\u9FFF\u3400-\u4DBF]/,           // Chinese, Japanese Kanji
      hiragana: /[\u3040-\u309F]/,                   // Japanese
      katakana: /[\u30A0-\u30FF]/,                   // Japanese
      hangul: /[\uAC00-\uD7AF\u1100-\u11FF]/,        // Korean
      thai: /[\u0E00-\u0E7F]/                        // Thai
    };
    
    for (const [script, regex] of Object.entries(scripts)) {
      if (regex.test(text)) {
        return script;
      }
    }
    
    // If no special scripts are detected but there are non-Latin characters
    if (/[^\u0000-\u007F]/.test(text)) {
      return 'non-latin';
    }
    
    return 'latin';
  }
  
  // Helper function to check if a string is likely to contain code or SQL injection
  containsSecurityThreat(text) {
    if (!text || typeof text !== 'string') return false;
    
    const lowered = text.toLowerCase();
    for (const pattern of this.securityPatterns) {
      if (lowered.includes(pattern.toLowerCase())) {
        return true;
      }
    }
    
    return false;
  }
  
  // Helper function for proper capitalization with exceptions for name particles
  properCapitalize(name, isLastName = false) {
    if (!name) return '';
    
    // Skip capitalization for non-Latin scripts
    const script = this.detectScript(name);
    if (script !== 'latin' && script !== 'unknown') {
      return name;
    }
    
    // Handle hyphenated names
    if (name.includes('-')) {
      return name.split('-')
        .map(part => this.properCapitalize(part, isLastName))
        .join('-');
    }
    
    // Check for special case corrections
    const loweredName = name.toLowerCase();
    if (this.specialCaseCorrections.has(loweredName)) {
      return this.specialCaseCorrections.get(loweredName);
    }
    
    // Handle special case for McSomething and MacSomething
    if ((loweredName.startsWith('mc') || loweredName.startsWith('mac')) && name.length > 3) {
      const prefix = name.substring(0, loweredName.startsWith('mac') ? 3 : 2);
      const rest = name.substring(loweredName.startsWith('mac') ? 3 : 2);
      return prefix.charAt(0).toUpperCase() + prefix.slice(1).toLowerCase() + 
             rest.charAt(0).toUpperCase() + rest.slice(1).toLowerCase();
    }
    
    // Handle O'Something names
    if (loweredName.startsWith("o'") && name.length > 2) {
      return "O'" + name.charAt(2).toUpperCase() + name.slice(3).toLowerCase();
    }
    
    // Handle names with apostrophes in the middle (D'Artagnan)
    if (name.includes("'") && !loweredName.startsWith("o'")) {
      const parts = name.split("'");
      if (parts.length >= 2) {
        return parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase() + 
               "'" + (parts[1].charAt(0).toUpperCase() + parts[1].slice(1).toLowerCase());
      }
    }
    
    // Handle name particles
    for (const particle of this.nameParticles) {
      if (loweredName === particle) {
        return isLastName ? name.charAt(0).toUpperCase() + name.slice(1).toLowerCase() : name.toLowerCase();
      }
      
      if (loweredName.startsWith(particle.toLowerCase() + ' ')) {
        const particlePart = isLastName ? particle.charAt(0).toUpperCase() + particle.slice(1).toLowerCase() : particle.toLowerCase();
        const remainingPart = name.slice(particle.length + 1);
        return `${particlePart} ${this.properCapitalize(remainingPart, isLastName)}`;
      }
    }
    
    // Default capitalization
    return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  }
  
  // Fix common character encoding issues
  fixEncodingIssues(text) {
    if (!text || typeof text !== 'string') return text;
    
    return text
      .replace(/Ã¡/g, 'á')
      .replace(/Ã©/g, 'é')
      .replace(/Ã­/g, 'í')
      .replace(/Ã³/g, 'ó')
      .replace(/Ãº/g, 'ú')
      .replace(/Ã±/g, 'ñ')
      .replace(/Ã¤/g, 'ä')
      .replace(/Ã¶/g, 'ö')
      .replace(/Ã¼/g, 'ü')
      .replace(/Ã¨/g, 'è')
      .replace(/Ã´/g, 'ô')
      .replace(/Ã®/g, 'î')
      .replace(/�/g, '');
  }
  
  // Basic name format validation - fast and synchronous
  isValidNameFormat(name) {
    // Check if name is a string
    if (typeof name !== 'string') {
      return false;
    }
    
    // Check if name is not empty after trimming
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      return false;
    }
    
    // Check for minimum length (e.g., at least 2 characters)
    if (trimmedName.length < 2) {
      return false;
    }
    
    // Check if name contains only valid characters (letters, spaces, hyphens, apostrophes)
    const validNameRegex = /^[\p{L}\p{M}'\-\s.]+$/u;
    return validNameRegex.test(trimmedName);
  }
  
  // Handle validation when first name and last name are provided separately
  validateSeparateNames(firstName, lastName) {
    console.log('NAME_VALIDATION: Processing separate first/last name components', {
      firstName,
      lastName
    });
    
    // Handle null, undefined, etc.
    if ((!firstName && !lastName) || (firstName === '' && lastName === '')) {
      return {
        originalName: '',
        currentName: '',
        firstName: '',
        lastName: '',
        middleName: '',
        honorific: '',
        suffix: '',
        script: 'unknown',
        formatValid: false,
        status: 'invalid',
        subStatus: 'empty_name',
        potentialIssues: ['Null or empty name components'],
        confidenceLevel: 'low'
      };
    }

    // Sanitize the inputs
    const sanitizedFirst = firstName ? String(firstName).trim().replace(/\s+/g, ' ') : '';
    const sanitizedLast = lastName ? String(lastName).trim().replace(/\s+/g, ' ') : '';
    
    // Reconstruct full name for logging and reference
    const fullName = [sanitizedFirst, sanitizedLast].filter(Boolean).join(' ');
    
    // Check script/language for each component
    const firstNameScript = this.detectScript(sanitizedFirst);
    const lastNameScript = this.detectScript(sanitizedLast);
    
    // Initialize result object
    const result = {
      originalName: fullName,
      currentName: fullName,
      firstName: '',
      lastName: '',
      middleName: '',
      honorific: '',
      suffix: '',
      script: 'latin', // Default, will update based on components
      formatValid: true,
      status: 'valid',
      subStatus: 'valid_format',
      potentialIssues: [],
      confidenceLevel: 'high',
      isCommaFormat: false
    };
    
    // Set script based on component scripts - prioritize non-Latin scripts
    if (firstNameScript !== 'latin' && firstNameScript !== 'unknown') {
      result.script = firstNameScript;
    } else if (lastNameScript !== 'latin' && lastNameScript !== 'unknown') {
      result.script = lastNameScript;
    }
    
    // Process first name component
    if (sanitizedFirst) {
      // Check for security threats
      if (this.containsSecurityThreat(sanitizedFirst)) {
        result.potentialIssues.push('First name may contain code or SQL patterns');
        result.confidenceLevel = 'low';
        result.status = 'invalid';
        result.subStatus = 'security_risk';
        return result;
      }
      
      // Check for suspicious test names
      for (const fake of this.suspiciousNames) {
        if (sanitizedFirst.toLowerCase().includes(fake.toLowerCase())) {
          result.potentialIssues.push('First name may be a test or placeholder');
          result.confidenceLevel = 'low';
          break;
        }
      }
      
      // Check for honorific in first name
      const firstNameParts = sanitizedFirst.split(' ');
      if (firstNameParts.length > 1) {
        const firstComponent = firstNameParts[0].toLowerCase().replace(/\.$/, '');
        if (this.honorifics.has(firstComponent)) {
          result.honorific = this.properCapitalize(firstNameParts[0]);
          result.firstName = firstNameParts.slice(1).join(' ');
        } else {
          // If no honorific, consider first part as first name and rest as middle name
          result.firstName = firstNameParts[0];
          if (firstNameParts.length > 1) {
            result.middleName = firstNameParts.slice(1).join(' ');
          }
        }
      } else {
        result.firstName = sanitizedFirst;
      }
    }
    
    // Process last name component
    if (sanitizedLast) {
      // Check for security threats
      if (this.containsSecurityThreat(sanitizedLast)) {
        result.potentialIssues.push('Last name may contain code or SQL patterns');
        result.confidenceLevel = 'low';
        result.status = 'invalid';
        result.subStatus = 'security_risk';
        return result;
      }
      
      // Check for suspicious test names
      for (const fake of this.suspiciousNames) {
        if (sanitizedLast.toLowerCase().includes(fake.toLowerCase())) {
          result.potentialIssues.push('Last name may be a test or placeholder');
          result.confidenceLevel = 'low';
          break;
        }
      }
      
      // Check for suffix in last name
      const lastNameParts = sanitizedLast.split(' ');
      if (lastNameParts.length > 1) {
        const lastComponent = lastNameParts[lastNameParts.length - 1].toLowerCase().replace(/\.$/, '').replace(/,/g, '');
        if (this.suffixes.has(lastComponent) || lastComponent.startsWith('jr') || lastComponent.startsWith('sr')) {
          result.suffix = lastComponent.toUpperCase();
          result.lastName = lastNameParts.slice(0, -1).join(' ');
        } else {
          result.lastName = sanitizedLast;
        }
      } else {
        result.lastName = sanitizedLast;
      }
    }
    
    // Apply proper capitalization to all components
    result.firstName = this.properCapitalize(result.firstName);
    result.lastName = this.properCapitalize(result.lastName, true);
    
    if (result.middleName) {
      result.middleName = this.properCapitalize(result.middleName);
    }
    
    // If there's no valid first or last name, mark as potentially problematic
    if (!result.firstName && !result.lastName) {
      result.formatValid = false;
      result.status = 'invalid';
      result.subStatus = 'invalid_format';
      result.potentialIssues.push('Missing both first and last name');
      result.confidenceLevel = 'low';
    } else if (!result.firstName) {
      result.potentialIssues.push('Missing first name');
      result.confidenceLevel = 'medium';
    } else if (!result.lastName) {
      result.potentialIssues.push('Missing last name');
      result.confidenceLevel = 'medium';
    }
    
    return result;
  }
  
  // Main validation function
  validateName(name) {
    console.log('NAME_VALIDATION: Starting validation for name', { name });
    
    // Handle null, undefined, etc.
    if (name === null || name === undefined || name === '') {
      return {
        originalName: name || '',
        currentName: '',
        firstName: '',
        lastName: '',
        middleName: '',
        honorific: '',
        suffix: '',
        script: 'unknown',
        formatValid: false,
        status: 'invalid',
        subStatus: 'empty_name',
        potentialIssues: ['Null or empty name'],
        confidenceLevel: 'low'
      };
    }

    // Ensure string type and sanitize
    let inputStr = String(name).trim();
    const sanitizedName = inputStr.replace(/\s+/g, ' ');
    
    // Check format validation
    const formatValid = this.isValidNameFormat(sanitizedName);
    
    // Initialize result object
    const result = {
      originalName: name,
      currentName: sanitizedName,
      firstName: '',
      lastName: '',
      middleName: '',
      honorific: '',
      suffix: '',
      script: this.detectScript(sanitizedName),
      formatValid: formatValid,
      status: formatValid ? 'valid' : 'invalid',
      subStatus: formatValid ? 'valid_format' : 'invalid_format',
      potentialIssues: [],
      confidenceLevel: 'high',
      isCommaFormat: false
    };
    
    // If format is invalid, return immediately
    if (!formatValid) {
      result.potentialIssues.push('Invalid name format');
      result.confidenceLevel = 'low';
      return result;
    }
    
    // Check for suspicious test names
    let isSuspicious = false;
    for (const fake of this.suspiciousNames) {
      if (sanitizedName.toLowerCase().includes(fake.toLowerCase())) {
        result.potentialIssues.push('Name may be a test or placeholder');
        result.confidenceLevel = 'low';
        isSuspicious = true;
        break;
      }
    }
    
    // Check for security threats
    if (this.containsSecurityThreat(sanitizedName)) {
      result.potentialIssues.push('Name may contain code or SQL patterns');
      result.confidenceLevel = 'low';
      result.status = 'invalid';
      result.subStatus = 'security_risk';
      return result;
    }
    
    // Handle encoding issues
    if (result.script === 'encoding-issue') {
      result.potentialIssues.push('Character encoding issues detected');
      result.confidenceLevel = 'medium';
      
      // Try to fix common encoding problems
      const fixedName = this.fixEncodingIssues(sanitizedName);
      
      if (fixedName !== sanitizedName) {
        result.currentName = fixedName;
        result.potentialIssues.push('Attempted to fix encoding issues');
        // Update script detection with fixed name
        result.script = this.detectScript(fixedName);
      }
    }
    
    // Process the name for parsing
    let nameToProcess = result.currentName;
    
    // Process non-Latin names differently
    if (result.script !== 'latin' && result.script !== 'unknown' && result.script !== 'encoding-issue') {
      result.potentialIssues.push('Non-Latin script detected - name splitting might be approximate');
      result.confidenceLevel = 'medium';
      
      // For many Asian languages that don't use spaces between words
      if (['han', 'hiragana', 'katakana', 'thai'].includes(result.script)) {
        if (nameToProcess.includes(' ')) {
          // If spaces exist, treat the first part as first name, rest as last name
          const parts = nameToProcess.split(' ');
          result.firstName = parts[0];
          result.lastName = parts.slice(1).join(' ');
        } else {
          // If no spaces, just use the whole thing as the last name
          result.lastName = nameToProcess;
          result.potentialIssues.push('Non-Latin name without spaces - assuming entire name is family name');
        }
        return result;
      }
    }
    
    // Handle comma-separated format (last name, first name)
    if (nameToProcess.includes(',')) {
      result.isCommaFormat = true;
      const parts = nameToProcess.split(',').map(p => p.trim());
      
      // In "LastName, FirstName MiddleName" format
      result.lastName = parts[0];
      
      if (parts.length > 1) {
        const remainingParts = parts[1].split(' ').filter(Boolean);
        if (remainingParts.length === 1) {
          result.firstName = remainingParts[0];
        } else if (remainingParts.length > 1) {
          result.firstName = remainingParts[0];
          result.middleName = remainingParts.slice(1).join(' ');
        }
      }
      
      // Apply proper capitalization
      result.lastName = this.properCapitalize(result.lastName, true);
      result.firstName = this.properCapitalize(result.firstName);
      result.middleName = this.properCapitalize(result.middleName);
      
      return result;
    }
    
    // Split the name into components
    const components = nameToProcess.split(' ').filter(Boolean);
    
    // Process name components
    let remainingComponents = [...components];
    
    // Check for honorific
    if (components.length > 1) {
      const firstComponent = components[0].toLowerCase().replace(/\.$/, '');
      if (this.honorifics.has(firstComponent)) {
        result.honorific = this.properCapitalize(components[0]);
        remainingComponents.shift();
      }
    }
    
    // Check for suffix
    if (components.length > 1) {
      const lastComponent = components[components.length - 1].toLowerCase().replace(/\.$/, '').replace(/,/g, '');
      if (this.suffixes.has(lastComponent)) {
        result.suffix = lastComponent.toUpperCase();
        remainingComponents.pop();
      } else if (lastComponent.startsWith('jr') || lastComponent.startsWith('sr')) {
        result.suffix = lastComponent.toUpperCase();
        remainingComponents.pop();
      }
    }
    
    // Check if we have any components left to process
    if (remainingComponents.length === 0) {
      result.potentialIssues.push('Name consists of only honorifics/suffixes');
      result.confidenceLevel = 'low';
      return result;
    }
    
    // Now process first, middle, and last names
    if (remainingComponents.length === 1) {
      // Only one name component remaining - treat as first name
      result.firstName = this.properCapitalize(remainingComponents[0]);
      result.potentialIssues.push('Only a single name was provided');
      result.confidenceLevel = 'medium';
    } else if (remainingComponents.length === 2) {
      // Two components - treat as first and last name
      result.firstName = this.properCapitalize(remainingComponents[0]);
      result.lastName = this.properCapitalize(remainingComponents[1], true);
    } else if (remainingComponents.length >= 3) {
      // Multiple components - need more complex handling
      
      // Start with simple approach: first component is first name, last component is last name
      result.firstName = this.properCapitalize(remainingComponents[0]);
      result.lastName = this.properCapitalize(remainingComponents[remainingComponents.length - 1], true);
      
      // Everything in the middle is considered middle name(s)
      result.middleName = remainingComponents
        .slice(1, remainingComponents.length - 1)
        .map(name => this.properCapitalize(name))
        .join(' ');
    }
    
    return result;
  }
  
  // Batch validation - process multiple names at once
  validateBatch(names) {
    console.log('NAME_VALIDATION: Starting batch validation', { batchSize: names.length });
    
    const results = [];
    for (const name of names) {
      results.push(this.validateName(name));
    }
    
    console.log('NAME_VALIDATION: Completed batch validation', { batchSize: names.length });
    return results;
  }
}