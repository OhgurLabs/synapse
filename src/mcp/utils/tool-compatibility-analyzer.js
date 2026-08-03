/**
 * ToolCompatibilityAnalyzer
 *
 * Analyzes tool compatibility for fallback selection by comparing input and output schemas.
 * Determines if a fallback tool can handle the same parameters and produce equivalent outputs.
 *
 * Features:
 * - Parameter compatibility analysis: Checks if fallback tool accepts the same input parameters
 * - Output equivalence analysis: Verifies that fallback produces compatible output structure
 * - Transformation support: Considers parameter transformation rules for adaptation
 * - Compatibility scoring: Provides quantitative compatibility score for ranking alternatives
 * - Constraint validation: Ensures parameter constraints are compatible between tools
 *
 * Usage:
 *   const analyzer = new ToolCompatibilityAnalyzer();
 *   const result = analyzer.checkCompatibility(primaryTool, fallbackTool, parameters);
 *   if (result.isCompatible) {
 *     // Use fallback tool with optional transformations
 *   }
 */

import { createLogger } from '../../logger.js';

const log = createLogger('tool-compatibility-analyzer');

/**
 * Compatibility levels for fallback tools
 */
export const CompatibilityLevel = {
  FULL: 'full',
  PARTIAL: 'partial',
  WITH_TRANSFORMATION: 'with_transformation',
  INCOMPATIBLE: 'incompatible'
};

/**
 * Parameter compatibility status
 */
export const ParameterStatus = {
  COMPATIBLE: 'compatible',
  INCOMPATIBLE: 'incompatible',
  TRANSFORMABLE: 'transformable',
  MISSING_REQUIRED: 'missing_required',
  EXTRA_OPTIONAL: 'extra_optional'
};

/**
 * Default compatibility thresholds
 */
export const DEFAULT_THRESHOLDS = {
  MIN_COMPATIBILITY_SCORE: 0.7,
  MIN_REQUIRED_PARAMETER_MATCH: 1.0,
  MAX_MISSING_OPTIONAL: 0.3,
  MIN_OUTPUT_COMPATIBILITY: 0.6
};

/**
 * Type compatibility matrix
 * Maps source types to compatible target types
 * Integer is compatible with number since all integers are numbers
 */
const TYPE_COMPATIBILITY = {
  string: ['string'],
  number: ['number'],
  integer: ['integer', 'number'],
  boolean: ['boolean'],
  array: ['array'],
  object: ['object'],
  null: ['null'],
  any: ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']
};

/**
 * ToolCompatibilityAnalyzer - Analyzes tool compatibility for fallback selection
 */
export class ToolCompatibilityAnalyzer {
  /**
   * @param {Object} options
   * @param {Object} options.thresholds - Compatibility thresholds
   * @param {boolean} options.enableTransformations - Enable parameter transformation detection
   * @param {boolean} options.strictMode - Enable strict compatibility checking
   */
  constructor(options = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
    this.enableTransformations = options.enableTransformations !== false;
    this.strictMode = options.strictMode === true;
    
    // Cache for analysis results
    this._analysisCache = new Map();
  }

  /**
   * Check if a fallback tool is compatible with a primary tool.
   *
   * @param {Object} primaryTool - Primary tool metadata
   * @param {Object} fallbackTool - Fallback tool metadata
   * @param {Object} parameters - Parameters to be passed (optional)
   * @param {Object} options - Analysis options
   * @returns {Object} Compatibility analysis result
   */
  checkCompatibility(primaryTool, fallbackTool, parameters = {}, options = {}) {
    const cacheKey = this._getCacheKey(primaryTool, fallbackTool, parameters, options);
    
    if (this._analysisCache.has(cacheKey)) {
      return this._analysisCache.get(cacheKey);
    }

    const result = {
      isCompatible: false,
      compatibilityLevel: CompatibilityLevel.INCOMPATIBLE,
      compatibilityScore: 0,
      inputCompatibility: null,
      outputCompatibility: null,
      transformations: [],
      warnings: [],
      recommendations: []
    };

    try {
      // Analyze input compatibility
      result.inputCompatibility = this._analyzeInputCompatibility(
        primaryTool,
        fallbackTool,
        parameters
      );

      // Analyze output compatibility
      result.outputCompatibility = this._analyzeOutputCompatibility(
        primaryTool,
        fallbackTool
      );

      // Calculate overall compatibility score
      result.compatibilityScore = this._calculateCompatibilityScore(
        result.inputCompatibility,
        result.outputCompatibility
      );

      // Determine compatibility level
      result.compatibilityLevel = this._determineCompatibilityLevel(
        result.inputCompatibility,
        result.outputCompatibility,
        result.compatibilityScore
      );

      // Check if compatible based on thresholds
      result.isCompatible = this._isCompatible(result);

      // Generate transformations if needed
      if (this.enableTransformations && result.inputCompatibility.needsTransformation) {
        result.transformations = this._generateTransformations(
          primaryTool,
          fallbackTool,
          result.inputCompatibility
        );
      }

      // Generate recommendations
      result.recommendations = this._generateRecommendations(result);

      log.debug({
        primaryTool: primaryTool.name,
        fallbackTool: fallbackTool.name,
        compatibilityLevel: result.compatibilityLevel,
        score: result.compatibilityScore
      }, 'Tool compatibility analysis complete');

    } catch (err) {
      log.error({
        primaryTool: primaryTool.name,
        fallbackTool: fallbackTool.name,
        error: err.message
      }, 'Tool compatibility analysis failed');
      
      result.warnings.push(`Analysis failed: ${err.message}`);
    }

    this._analysisCache.set(cacheKey, result);
    return result;
  }

  /**
   * Analyze input parameter compatibility between tools.
   *
   * @private
   * @param {Object} primaryTool - Primary tool metadata
   * @param {Object} fallbackTool - Fallback tool metadata
   * @param {Object} parameters - Parameters to be passed
   * @returns {Object} Input compatibility analysis
   */
  _analyzeInputCompatibility(primaryTool, fallbackTool, parameters) {
    const primarySchema = primaryTool.metadata?.inputSchema || {};
    const fallbackSchema = fallbackTool.metadata?.inputSchema || {};

    const result = {
      isCompatible: true,
      score: 0,
      parameters: [],
      missingRequired: [],
      incompatibleParameters: [],
      transformableParameters: [],
      needsTransformation: false,
      canTransform: false
    };

    const primaryProps = primarySchema.properties || {};
    const fallbackProps = fallbackSchema.properties || {};
    const primaryRequired = primarySchema.required || [];
    const fallbackRequired = fallbackSchema.required || [];

    let compatibleCount = 0;
    let totalParameters = 0;
    let requiredCompatibleCount = 0;
    let totalRequired = 0;

    // Check each parameter from primary tool
    for (const [paramName, primaryParam] of Object.entries(primaryProps)) {
      totalParameters++;
      const isPrimaryRequired = primaryRequired.includes(paramName);
      if (isPrimaryRequired) {
        totalRequired++;
      }
      const fallbackParam = fallbackProps[paramName];
      
      const paramResult = {
        name: paramName,
        status: ParameterStatus.COMPATIBLE,
        isRequired: isPrimaryRequired,
        primaryType: primaryParam.type,
        fallbackType: fallbackParam?.type,
        needsTransformation: false,
        canTransform: false
      };

      if (!fallbackParam) {
        // Parameter doesn't exist in fallback
        if (isPrimaryRequired) {
          paramResult.status = ParameterStatus.MISSING_REQUIRED;
          result.missingRequired.push(paramName);
          result.incompatibleParameters.push(paramResult);
          result.isCompatible = false;
        } else {
          paramResult.status = ParameterStatus.EXTRA_OPTIONAL;
          result.warnings = result.warnings || [];
          result.warnings.push(`Optional parameter '${paramName}' not available in fallback`);
        }
      } else {
        // Check type compatibility
        const typeCheck = this._checkTypeCompatibility(primaryParam, fallbackParam);
        paramResult.isTypeCompatible = typeCheck.isCompatible;
        paramResult.typeMatch = typeCheck.match;

        if (!typeCheck.isCompatible) {
          // Check if transformation is possible
          const transformCheck = this._checkTransformationPossibility(
            primaryParam,
            fallbackParam,
            parameters[paramName]
          );
          paramResult.needsTransformation = true;
          paramResult.canTransform = transformCheck.canTransform;
          paramResult.status = transformCheck.canTransform 
            ? ParameterStatus.TRANSFORMABLE 
            : ParameterStatus.INCOMPATIBLE;
          
          if (transformCheck.canTransform) {
            result.transformableParameters.push(paramName);
            result.needsTransformation = true;
            result.canTransform = true;
            // Count transformable as partially compatible (0.5)
            compatibleCount += 0.5;
          } else {
            result.incompatibleParameters.push(paramResult);
            if (isPrimaryRequired) {
              result.isCompatible = false;
            }
          }
        } else {
          // Check constraint compatibility
          const constraintCheck = this._checkConstraintCompatibility(
            primaryParam,
            fallbackParam
          );
          paramResult.constraintsCompatible = constraintCheck.isCompatible;
          
          if (!constraintCheck.isCompatible) {
            paramResult.status = ParameterStatus.INCOMPATIBLE;
            result.incompatibleParameters.push(paramResult);
            if (isPrimaryRequired) {
              result.isCompatible = false;
            }
          } else {
            compatibleCount++;
            if (isPrimaryRequired) {
              requiredCompatibleCount++;
            }
          }
        }
      }

      result.parameters.push(paramResult);
    }

    // Check for additional required parameters in fallback
    for (const paramName of fallbackRequired) {
      if (!primaryProps[paramName]) {
        result.warnings = result.warnings || [];
        result.warnings.push(
          `Fallback requires additional parameter '${paramName}' not in primary`
        );
      }
    }

    // Calculate compatibility score
    // Simple ratio: compatible parameters / total parameters
    // Transformable parameters count as 0.5, compatible as 1.0
    result.score = totalParameters > 0 ? compatibleCount / totalParameters : 1;

    return result;
  }

  /**
   * Analyze output compatibility between tools.
   *
   * @private
   * @param {Object} primaryTool - Primary tool metadata
   * @param {Object} fallbackTool - Fallback tool metadata
   * @returns {Object} Output compatibility analysis
   */
  _analyzeOutputCompatibility(primaryTool, fallbackTool) {
    const primarySchema = primaryTool.metadata?.outputSchema || {};
    const fallbackSchema = fallbackTool.metadata?.outputSchema || {};

    const result = {
      isCompatible: true,
      score: 0,
      structureMatch: false,
      typeMatch: false,
      differences: [],
      canAdapt: false
    };

    // If neither has output schema, assume compatible
    if (!primarySchema.type && !fallbackSchema.type) {
      result.score = 1;
      result.structureMatch = true;
      result.typeMatch = true;
      return result;
    }

    // If only one has output schema, partial compatibility
    if (!primarySchema.type || !fallbackSchema.type) {
      result.score = 0.5;
      result.differences.push('Only one tool has output schema defined');
      return result;
    }

    // Check type compatibility
    const typeCheck = this._checkTypeCompatibility(primarySchema, fallbackSchema);
    result.typeMatch = typeCheck.isCompatible;

    // Check structure compatibility for objects
    if (primarySchema.type === 'object' && fallbackSchema.type === 'object') {
      const primaryProps = primarySchema.properties || {};
      const fallbackProps = fallbackSchema.properties || {};
      
      let matchedProps = 0;
      const totalPrimaryProps = Object.keys(primaryProps).length;

      for (const [propName, primaryProp] of Object.entries(primaryProps)) {
        const fallbackProp = fallbackProps[propName];
        if (fallbackProp) {
          const propTypeCheck = this._checkTypeCompatibility(primaryProp, fallbackProp);
          if (propTypeCheck.isCompatible) {
            matchedProps++;
          } else {
            result.differences.push(
              `Property '${propName}' type mismatch: ${primaryProp.type} vs ${fallbackProp.type}`
            );
          }
        } else {
          result.differences.push(`Property '${propName}' missing in fallback output`);
        }
      }

      result.structureMatch = totalPrimaryProps > 0 ? matchedProps / totalPrimaryProps >= 0.7 : true;
      result.score = totalPrimaryProps > 0 ? matchedProps / totalPrimaryProps : 1;
    } else if (result.typeMatch) {
      // Non-object types with matching types
      result.structureMatch = true;
      result.score = 1;
    } else {
      result.score = 0;
    }

    result.isCompatible = result.score >= this.thresholds.MIN_OUTPUT_COMPATIBILITY;

    return result;
  }

  /**
   * Check if two parameter types are compatible.
   *
   * @private
   * @param {Object} primaryParam - Primary parameter schema
   * @param {Object} fallbackParam - Fallback parameter schema
   * @returns {Object} Type compatibility check result
   */
  _checkTypeCompatibility(primaryParam, fallbackParam) {
    const primaryType = primaryParam.type;
    const fallbackType = fallbackParam.type;

    // Handle 'any' type
    if (primaryType === 'any' || fallbackType === 'any') {
      return { isCompatible: true, match: 'any' };
    }

    // Handle array types
    if (primaryType === 'array' && fallbackType === 'array') {
      const primaryItems = primaryParam.items || {};
      const fallbackItems = fallbackParam.items || {};
      
      if (!primaryItems.type && !fallbackItems.type) {
        return { isCompatible: true, match: 'array' };
      }

      const itemsCheck = this._checkTypeCompatibility(primaryItems, fallbackItems);
      return itemsCheck;
    }

    // Handle enum values
    if (primaryParam.enum && fallbackParam.enum) {
      const enumIntersection = primaryParam.enum.filter(
        val => fallbackParam.enum.includes(val)
      );
      return {
        isCompatible: enumIntersection.length > 0,
        match: 'enum',
        intersection: enumIntersection
      };
    }

    // Check type compatibility matrix
    const compatibleTypes = TYPE_COMPATIBILITY[primaryType] || [primaryType];
    const isCompatible = compatibleTypes.includes(fallbackType);

    return {
      isCompatible,
      match: isCompatible ? fallbackType : null,
      primaryType,
      fallbackType
    };
  }

  /**
   * Check if parameter transformation is possible.
   *
   * @private
   * @param {Object} primaryParam - Primary parameter schema
   * @param {Object} fallbackParam - Fallback parameter schema
   * @param {*} value - Parameter value to transform
   * @returns {Object} Transformation possibility check result
   */
  _checkTransformationPossibility(primaryParam, fallbackParam, value) {
    const primaryType = primaryParam.type;
    const fallbackType = fallbackParam.type;

    // String to number transformation
    if (primaryType === 'string' && (fallbackType === 'number' || fallbackType === 'integer')) {
      const num = Number(value);
      return {
        canTransform: !isNaN(num),
        transformType: 'string_to_number',
        description: 'Convert string to number'
      };
    }

    // Number to string transformation
    if ((primaryType === 'number' || primaryType === 'integer') && fallbackType === 'string') {
      return {
        canTransform: true,
        transformType: 'number_to_string',
        description: 'Convert number to string'
      };
    }

    // Boolean to string transformation
    if (primaryType === 'boolean' && fallbackType === 'string') {
      return {
        canTransform: true,
        transformType: 'boolean_to_string',
        description: 'Convert boolean to string'
      };
    }

    // String to boolean transformation
    if (primaryType === 'string' && fallbackType === 'boolean') {
      const lower = String(value).toLowerCase();
      return {
        canTransform: ['true', 'false', '1', '0', 'yes', 'no'].includes(lower),
        transformType: 'string_to_boolean',
        description: 'Convert string to boolean'
      };
    }

    // Array to comma-separated string
    if (primaryType === 'array' && fallbackType === 'string' && primaryParam.items?.type === 'string') {
      return {
        canTransform: Array.isArray(value),
        transformType: 'array_to_csv_string',
        description: 'Convert string array to comma-separated string'
      };
    }

    // Comma-separated string to array
    if (primaryType === 'string' && fallbackType === 'array' && fallbackParam.items?.type === 'string') {
      return {
        canTransform: typeof value === 'string',
        transformType: 'csv_string_to_array',
        description: 'Convert comma-separated string to array'
      };
    }

    return {
      canTransform: false,
      reason: `No transformation available from ${primaryType} to ${fallbackType}`
    };
  }

  /**
   * Check if parameter constraints are compatible.
   *
   * @private
   * @param {Object} primaryParam - Primary parameter schema
   * @param {Object} fallbackParam - Fallback parameter schema
   * @returns {Object} Constraint compatibility check result
   */
  _checkConstraintCompatibility(primaryParam, fallbackParam) {
    const result = {
      isCompatible: true,
      issues: []
    };

    // Check minimum/maximum for numbers
    if (primaryParam.minimum !== undefined && fallbackParam.maximum !== undefined) {
      if (primaryParam.minimum > fallbackParam.maximum) {
        result.isCompatible = false;
        result.issues.push(
          `Primary minimum (${primaryParam.minimum}) exceeds fallback maximum (${fallbackParam.maximum})`
        );
      }
    }

    if (primaryParam.maximum !== undefined && fallbackParam.minimum !== undefined) {
      if (primaryParam.maximum < fallbackParam.minimum) {
        result.isCompatible = false;
        result.issues.push(
          `Primary maximum (${primaryParam.maximum}) below fallback minimum (${fallbackParam.minimum})`
        );
      }
    }

    // Check minLength/maxLength for strings
    if (primaryParam.minLength !== undefined && fallbackParam.maxLength !== undefined) {
      if (primaryParam.minLength > fallbackParam.maxLength) {
        result.isCompatible = false;
        result.issues.push(
          `Primary minLength (${primaryParam.minLength}) exceeds fallback maxLength (${fallbackParam.maxLength})`
        );
      }
    }

    // Check pattern compatibility
    if (primaryParam.pattern && fallbackParam.pattern) {
      if (primaryParam.pattern !== fallbackParam.pattern) {
        result.issues.push('Different regex patterns may cause incompatibility');
        if (this.strictMode) {
          result.isCompatible = false;
        }
      }
    }

    // Check enum compatibility
    if (primaryParam.enum && fallbackParam.enum) {
      const primarySet = new Set(primaryParam.enum);
      const fallbackSet = new Set(fallbackParam.enum);
      const intersection = [...primarySet].filter(x => fallbackSet.has(x));
      
      if (intersection.length === 0) {
        result.isCompatible = false;
        result.issues.push('No common enum values');
      }
    }

    return result;
  }

  /**
   * Calculate overall compatibility score.
   *
   * @private
   * @param {Object} inputCompat - Input compatibility analysis
   * @param {Object} outputCompat - Output compatibility analysis
   * @returns {number} Overall compatibility score (0-1)
   */
  _calculateCompatibilityScore(inputCompat, outputCompat) {
    // Weight input compatibility higher than output
    const inputWeight = 0.7;
    const outputWeight = 0.3;

    let inputScore = inputCompat.score;
    let outputScore = outputCompat.score;

    // Penalize missing required parameters heavily - set overall score to 0
    if (inputCompat.missingRequired.length > 0) {
      return 0;
    }

    // Boost score for transformable parameters
    if (inputCompat.needsTransformation && inputCompat.canTransform) {
      // Transformable parameters get partial credit
      inputScore = Math.min(1, inputScore + (inputCompat.transformableParameters.length * 0.2));
    }

    // Penalize incompatible required parameters
    const requiredIncompatible = inputCompat.incompatibleParameters.filter(p => p.isRequired);
    if (requiredIncompatible.length > 0) {
      inputScore *= 0.5;
    }

    return (inputScore * inputWeight) + (outputScore * outputWeight);
  }

  /**
   * Determine compatibility level based on analysis.
   *
   * @private
   * @param {Object} inputCompat - Input compatibility analysis
   * @param {Object} outputCompat - Output compatibility analysis
   * @param {number} score - Overall compatibility score
   * @returns {string} Compatibility level
   */
  _determineCompatibilityLevel(inputCompat, outputCompat, score) {
    if (score >= 0.95) {
      return CompatibilityLevel.FULL;
    }

    if (inputCompat.missingRequired.length > 0) {
      return CompatibilityLevel.INCOMPATIBLE;
    }

    if (score >= this.thresholds.MIN_COMPATIBILITY_SCORE) {
      if (inputCompat.needsTransformation && inputCompat.canTransform) {
        return CompatibilityLevel.WITH_TRANSFORMATION;
      }
      return CompatibilityLevel.PARTIAL;
    }

    return CompatibilityLevel.INCOMPATIBLE;
  }

  /**
   * Check if tool is compatible based on thresholds.
   *
   * @private
   * @param {Object} result - Full compatibility analysis result
   * @returns {boolean} Whether tool is compatible
   */
  _isCompatible(result) {
    // Must not have missing required parameters
    if (result.inputCompatibility.missingRequired.length > 0) {
      return false;
    }

    // Check required parameter compatibility
    const requiredParams = result.inputCompatibility.parameters.filter(p => p.isRequired);
    const requiredIncompatible = requiredParams.filter(p => 
      p.status === ParameterStatus.INCOMPATIBLE
    );
    
    if (requiredIncompatible.length > 0) {
      return false;
    }

    // Check if all required parameters are either compatible or transformable
    const requiredNotCompatible = requiredParams.filter(p => 
      p.status !== ParameterStatus.COMPATIBLE && 
      p.status !== ParameterStatus.TRANSFORMABLE
    );
    
    if (requiredNotCompatible.length > 0) {
      return false;
    }

    // In strict mode, no incompatible parameters allowed (even optional)
    if (this.strictMode) {
      const incompatibleParams = result.inputCompatibility.parameters.filter(p => 
        p.status === ParameterStatus.INCOMPATIBLE
      );
      if (incompatibleParams.length > 0) {
        return false;
      }
    }

    // Must meet minimum score threshold (only if there are optional parameters)
    if (result.compatibilityScore < this.thresholds.MIN_COMPATIBILITY_SCORE) {
      // If score is low but all required params are OK, still consider it compatible
      // This handles the case where optional parameters are missing
      const allRequiredOk = requiredParams.length > 0 && 
        requiredParams.every(p => 
          p.status === ParameterStatus.COMPATIBLE || 
          p.status === ParameterStatus.TRANSFORMABLE
        );
      
      if (!allRequiredOk) {
        return false;
      }
    }

    // Must have transformable or compatible parameters
    if (result.inputCompatibility.needsTransformation && !result.inputCompatibility.canTransform) {
      return false;
    }

    return true;
  }

  /**
   * Generate transformation mappings for incompatible parameters.
   *
   * @private
   * @param {Object} primaryTool - Primary tool metadata
   * @param {Object} fallbackTool - Fallback tool metadata
   * @param {Object} inputCompat - Input compatibility analysis
   * @returns {Array<Object>} Transformation mappings
   */
  _generateTransformations(primaryTool, fallbackTool, inputCompat) {
    const transformations = [];
    const primarySchema = primaryTool.metadata?.inputSchema || {};
    const fallbackSchema = fallbackTool.metadata?.inputSchema || {};

    for (const param of inputCompat.transformableParameters) {
      const primaryParam = primarySchema.properties?.[param];
      const fallbackParam = fallbackSchema.properties?.[param];

      if (primaryParam && fallbackParam) {
        const transformCheck = this._checkTransformationPossibility(
          primaryParam,
          fallbackParam,
          null
        );

        transformations.push({
          parameter: param,
          from: primaryParam.type,
          to: fallbackParam.type,
          transformType: transformCheck.transformType,
          description: transformCheck.description,
          transformFunction: this._getTransformFunction(transformCheck.transformType)
        });
      }
    }

    return transformations;
  }

  /**
   * Get transformation function for a given type.
   *
   * @private
   * @param {string} transformType - Type of transformation
   * @returns {Function} Transformation function
   */
  _getTransformFunction(transformType) {
    const transforms = {
      string_to_number: (val) => Number(val),
      number_to_string: (val) => String(val),
      boolean_to_string: (val) => String(val),
      string_to_boolean: (val) => {
        const lower = String(val).toLowerCase();
        return ['true', '1', 'yes'].includes(lower);
      },
      array_to_csv_string: (val) => Array.isArray(val) ? val.join(',') : String(val),
      csv_string_to_array: (val) => String(val).split(',').map(s => s.trim())
    };

    return transforms[transformType] || ((val) => val);
  }

  /**
   * Generate recommendations for using the fallback tool.
   *
   * @private
   * @param {Object} result - Compatibility analysis result
   * @returns {Array<string>} Recommendations
   */
  _generateRecommendations(result) {
    const recommendations = [];

    if (result.compatibilityLevel === CompatibilityLevel.FULL) {
      recommendations.push('Fallback tool is fully compatible and can be used directly');
    } else if (result.compatibilityLevel === CompatibilityLevel.WITH_TRANSFORMATION) {
      recommendations.push(
        `Fallback tool requires parameter transformations: ${result.transformations.length} parameters need conversion`
      );
      recommendations.push('Apply transformations before invoking fallback tool');
    } else if (result.compatibilityLevel === CompatibilityLevel.PARTIAL) {
      recommendations.push('Fallback tool has partial compatibility');
      if (result.inputCompatibility.warnings?.length > 0) {
        recommendations.push(`Warning: ${result.inputCompatibility.warnings.length} compatibility issues detected`);
      }
    }

    if (result.outputCompatibility.differences?.length > 0) {
      recommendations.push(
        `Output structure differs: ${result.outputCompatibility.differences.length} differences detected`
      );
      recommendations.push('Consider post-processing fallback output to match primary tool format');
    }

    return recommendations;
  }

  /**
   * Generate cache key for analysis results.
   *
   * @private
   * @param {Object} primaryTool - Primary tool metadata
   * @param {Object} fallbackTool - Fallback tool metadata
   * @param {Object} parameters - Parameters
   * @param {Object} options - Analysis options
   * @returns {string} Cache key
   */
  _getCacheKey(primaryTool, fallbackTool, parameters, options) {
    const key = [
      primaryTool.name,
      fallbackTool.name,
      JSON.stringify(parameters),
      JSON.stringify(options)
    ].join('|');
    return key;
  }

  /**
   * Clear analysis cache.
   */
  clearCache() {
    this._analysisCache.clear();
  }

  /**
   * Get cache statistics.
   *
   * @returns {Object} Cache statistics
   */
  getCacheStats() {
    return {
      size: this._analysisCache.size,
      keys: Array.from(this._analysisCache.keys())
    };
  }
}
