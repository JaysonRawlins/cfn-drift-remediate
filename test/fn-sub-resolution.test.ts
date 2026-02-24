import { resolvePropertyValue } from '../src/lib/template-transformer';

describe('Fn::Sub resolution', () => {
  describe('string form', () => {
    it('should collect Ref-style references from Fn::Sub string', () => {
      const value = { 'Fn::Sub': 'arn:aws:s3:::${MyBucket}/*' };
      const drifted = new Set(['MyBucket']);
      const collected = new Map<string, unknown>();

      resolvePropertyValue(value, drifted, collected, true);

      expect(collected.has('Ref:MyBucket')).toBe(true);
    });

    it('should collect GetAtt-style references from Fn::Sub string', () => {
      const value = { 'Fn::Sub': '${MyBucket.Arn}/*' };
      const drifted = new Set(['MyBucket']);
      const collected = new Map<string, unknown>();

      resolvePropertyValue(value, drifted, collected, true);

      expect(collected.has('GetAtt:MyBucket:Arn')).toBe(true);
    });

    it('should resolve Fn::Sub string form to plain string when all refs resolved', () => {
      const value = { 'Fn::Sub': 'arn:aws:s3:::${MyBucket}/*' };
      const drifted = new Set(['MyBucket']);
      const resolved = new Map<string, unknown>([['Ref:MyBucket', 'my-actual-bucket']]);

      const result = resolvePropertyValue(value, drifted, resolved, false);

      expect(result).toBe('arn:aws:s3:::my-actual-bucket/*');
    });

    it('should keep Fn::Sub when pseudo-references remain', () => {
      const value = { 'Fn::Sub': 'arn:aws:s3:::${MyBucket}-${AWS::Region}' };
      const drifted = new Set(['MyBucket']);
      const resolved = new Map<string, unknown>([['Ref:MyBucket', 'my-bucket']]);

      const result = resolvePropertyValue(value, drifted, resolved, false);

      expect(result).toEqual({ 'Fn::Sub': 'arn:aws:s3:::my-bucket-${AWS::Region}' });
    });

    it('should not resolve pseudo-references', () => {
      const value = { 'Fn::Sub': '${AWS::StackName}-${AWS::Region}' };
      const drifted = new Set<string>();
      const resolved = new Map<string, unknown>();

      const result = resolvePropertyValue(value, drifted, resolved, false);

      expect(result).toEqual({ 'Fn::Sub': '${AWS::StackName}-${AWS::Region}' });
    });

    it('should not resolve references to non-drifted resources', () => {
      const value = { 'Fn::Sub': '${OtherResource}' };
      const drifted = new Set<string>();
      const resolved = new Map<string, unknown>();

      const result = resolvePropertyValue(value, drifted, resolved, false);

      expect(result).toEqual({ 'Fn::Sub': '${OtherResource}' });
    });

    it('should handle mixed drifted and non-drifted references', () => {
      const value = { 'Fn::Sub': '${MyBucket}-${OtherResource}' };
      const drifted = new Set(['MyBucket']);
      const resolved = new Map<string, unknown>([['Ref:MyBucket', 'actual-bucket']]);

      const result = resolvePropertyValue(value, drifted, resolved, false);

      expect(result).toEqual({ 'Fn::Sub': 'actual-bucket-${OtherResource}' });
    });

    it('should resolve GetAtt-style references in Fn::Sub', () => {
      const value = { 'Fn::Sub': 'arn:${MyBucket.Arn}:path' };
      const drifted = new Set(['MyBucket']);
      const resolved = new Map<string, unknown>([
        ['GetAtt:MyBucket:Arn', 'arn:aws:s3:::my-bucket'],
      ]);

      const result = resolvePropertyValue(value, drifted, resolved, false);

      expect(result).toBe('arn:arn:aws:s3:::my-bucket:path');
    });

    it('should handle multiple references to the same resource', () => {
      const value = { 'Fn::Sub': '${MyBucket}-${MyBucket}' };
      const drifted = new Set(['MyBucket']);
      const resolved = new Map<string, unknown>([['Ref:MyBucket', 'bucket-name']]);

      const result = resolvePropertyValue(value, drifted, resolved, false);

      expect(result).toBe('bucket-name-bucket-name');
    });
  });

  describe('array form', () => {
    it('should resolve variable map values containing Ref', () => {
      const value = {
        'Fn::Sub': [
          'arn:aws:s3:::${BucketName}/*',
          { BucketName: { Ref: 'MyBucket' } },
        ],
      };
      const drifted = new Set(['MyBucket']);
      const resolved = new Map<string, unknown>([['Ref:MyBucket', 'my-actual-bucket']]);

      const result = resolvePropertyValue(value, drifted, resolved, false);

      expect(result).toEqual({
        'Fn::Sub': [
          'arn:aws:s3:::${BucketName}/*',
          { BucketName: 'my-actual-bucket' },
        ],
      });
    });

    it('should collect references from array form variable map', () => {
      const value = {
        'Fn::Sub': [
          '${BucketVar}',
          { BucketVar: { Ref: 'MyBucket' } },
        ],
      };
      const drifted = new Set(['MyBucket']);
      const collected = new Map<string, unknown>();

      resolvePropertyValue(value, drifted, collected, true);

      expect(collected.has('Ref:MyBucket')).toBe(true);
    });

    it('should pass through array form when no drifted references', () => {
      const value = {
        'Fn::Sub': [
          '${BucketVar}',
          { BucketVar: { Ref: 'StableResource' } },
        ],
      };
      const drifted = new Set<string>();
      const resolved = new Map<string, unknown>();

      const result = resolvePropertyValue(value, drifted, resolved, false);

      expect(result).toEqual({
        'Fn::Sub': [
          '${BucketVar}',
          { BucketVar: { Ref: 'StableResource' } },
        ],
      });
    });
  });
});
