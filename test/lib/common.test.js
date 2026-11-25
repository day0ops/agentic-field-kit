import { describe, it, expect } from 'bun:test';
import { nlbSourceRangeAnnotations } from '../../src/lib/common.js';

describe('nlbSourceRangeAnnotations', () => {
  it('returns null when sourceRanges is empty', () => {
    expect(nlbSourceRangeAnnotations([])).toBeNull();
    expect(nlbSourceRangeAnnotations(null)).toBeNull();
  });

  it('always enables cross-zone load balancing when it returns annotations, so a single-replica backend is reachable regardless of which AZ the NLB receives traffic through', () => {
    const annotations = nlbSourceRangeAnnotations(['10.0.0.0/8']);
    expect(annotations['service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled']).toBe(
      'true'
    );
  });

  it('joins a flat list of CIDRs into the source-ranges annotation', () => {
    const annotations = nlbSourceRangeAnnotations(['10.0.0.0/8', '192.168.1.1/32']);
    expect(annotations['service.beta.kubernetes.io/load-balancer-source-ranges']).toBe(
      '10.0.0.0/8,192.168.1.1/32'
    );
  });

  it('flattens a mix of nested arrays and plain CIDR strings', () => {
    const annotations = nlbSourceRangeAnnotations([['10.0.0.0/8', '192.168.1.1/32'], '0.0.0.0/0']);
    expect(annotations['service.beta.kubernetes.io/load-balancer-source-ranges']).toBe(
      '10.0.0.0/8,192.168.1.1/32,0.0.0.0/0'
    );
  });

  it('turns client-IP preservation back on, required for source-ranges to take effect with nlb-target-type=ip', () => {
    const annotations = nlbSourceRangeAnnotations(['10.0.0.0/8']);
    expect(
      annotations['service.beta.kubernetes.io/aws-load-balancer-target-group-attributes']
    ).toBe('preserve_client_ip.enabled=true');
  });
});
