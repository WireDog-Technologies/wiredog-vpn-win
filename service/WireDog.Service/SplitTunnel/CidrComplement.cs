using System.Net;
using System.Numerics;

namespace WireDog.Service.SplitTunnel;

/// <summary>
/// Computes CIDR complement ranges for IP-based split tunneling.
/// Given a set of IPs/CIDRs to exclude, produces the complement set
/// that covers everything else. Same algorithm as Android TunnelConfigBuilder.
/// </summary>
public static class CidrComplement
{
    /// <summary>
    /// Given a list of CIDR ranges to exclude from the full address space,
    /// compute the complement (everything NOT in the excluded ranges).
    /// Works for both IPv4 and IPv6.
    /// </summary>
    public static List<string> ComputeComplement(IEnumerable<string> excludedCidrs)
    {
        var ipv4Exclusions = new List<(uint network, int prefix)>();
        var ipv6Exclusions = new List<(BigInteger network, int prefix)>();

        foreach (var cidr in excludedCidrs)
        {
            var trimmed = cidr.Trim();
            if (string.IsNullOrEmpty(trimmed)) continue;

            if (trimmed.Contains(':'))
            {
                // IPv6
                var parsed = ParseIpv6Cidr(trimmed);
                if (parsed.HasValue) ipv6Exclusions.Add(parsed.Value);
            }
            else
            {
                // IPv4
                var parsed = ParseIpv4Cidr(trimmed);
                if (parsed.HasValue) ipv4Exclusions.Add(parsed.Value);
            }
        }

        var result = new List<string>();

        // IPv4 complement
        if (ipv4Exclusions.Count > 0)
        {
            ComputeIpv4Complement(0, 0, ipv4Exclusions, result);
        }
        else
        {
            result.Add("0.0.0.0/0");
        }

        // IPv6 complement
        if (ipv6Exclusions.Count > 0)
        {
            ComputeIpv6Complement(BigInteger.Zero, 0, ipv6Exclusions, result);
        }
        else
        {
            result.Add("::/0");
        }

        return result;
    }

    private static void ComputeIpv4Complement(uint rangeStart, int prefixLen,
        List<(uint network, int prefix)> exclusions, List<string> result)
    {
        if (prefixLen > 32) return;

        // Check if any exclusion overlaps with this range
        uint rangeMask = prefixLen == 0 ? 0 : ~((1u << (32 - prefixLen)) - 1);
        uint rangeEnd = rangeStart | ~rangeMask;

        bool hasOverlap = false;
        foreach (var (network, prefix) in exclusions)
        {
            // Check if exclusion overlaps with this range
            if (RangesOverlapV4(rangeStart, rangeEnd, network, prefix))
            {
                hasOverlap = true;

                // If this range is entirely contained in the exclusion, skip it
                if (prefixLen >= prefix && (rangeStart & GetMaskV4(prefix)) == network)
                {
                    return; // Entire range is excluded
                }
            }
        }

        if (!hasOverlap)
        {
            // No exclusion overlaps — keep entire range
            result.Add(Uint32ToIpv4(rangeStart) + "/" + prefixLen);
            return;
        }

        // Split into two halves and recurse
        if (prefixLen >= 32) return;

        int nextPrefix = prefixLen + 1;
        uint halfSize = 1u << (32 - nextPrefix);

        ComputeIpv4Complement(rangeStart, nextPrefix, exclusions, result);
        ComputeIpv4Complement(rangeStart + halfSize, nextPrefix, exclusions, result);
    }

    private static void ComputeIpv6Complement(BigInteger rangeStart, int prefixLen,
        List<(BigInteger network, int prefix)> exclusions, List<string> result)
    {
        if (prefixLen > 128) return;

        BigInteger rangeSize = BigInteger.One << (128 - prefixLen);
        BigInteger rangeEnd = rangeStart + rangeSize - 1;

        bool hasOverlap = false;
        foreach (var (network, prefix) in exclusions)
        {
            BigInteger exclSize = BigInteger.One << (128 - prefix);
            BigInteger exclEnd = network + exclSize - 1;

            if (rangeStart <= exclEnd && rangeEnd >= network)
            {
                hasOverlap = true;

                // Entirely contained in exclusion
                if (prefixLen >= prefix && rangeStart >= network && rangeEnd <= exclEnd)
                {
                    return;
                }
            }
        }

        if (!hasOverlap)
        {
            result.Add(BigIntegerToIpv6(rangeStart) + "/" + prefixLen);
            return;
        }

        if (prefixLen >= 128) return;

        int nextPrefix = prefixLen + 1;
        BigInteger halfSize = BigInteger.One << (128 - nextPrefix);

        ComputeIpv6Complement(rangeStart, nextPrefix, exclusions, result);
        ComputeIpv6Complement(rangeStart + halfSize, nextPrefix, exclusions, result);
    }

    private static bool RangesOverlapV4(uint rangeStart, uint rangeEnd, uint network, int prefix)
    {
        uint mask = GetMaskV4(prefix);
        uint exclEnd = network | ~mask;
        return rangeStart <= exclEnd && rangeEnd >= network;
    }

    private static uint GetMaskV4(int prefix)
    {
        return prefix == 0 ? 0 : ~((1u << (32 - prefix)) - 1);
    }

    private static (uint network, int prefix)? ParseIpv4Cidr(string cidr)
    {
        int slashIndex = cidr.IndexOf('/');
        string ipPart = slashIndex >= 0 ? cidr[..slashIndex] : cidr;
        int prefix = slashIndex >= 0 ? int.Parse(cidr[(slashIndex + 1)..]) : 32;

        if (!IPAddress.TryParse(ipPart, out var ip)) return null;
        var bytes = ip.GetAddressBytes();
        uint addr = ((uint)bytes[0] << 24) | ((uint)bytes[1] << 16) | ((uint)bytes[2] << 8) | bytes[3];

        // Normalize to network address
        uint mask = GetMaskV4(prefix);
        return (addr & mask, prefix);
    }

    private static (BigInteger network, int prefix)? ParseIpv6Cidr(string cidr)
    {
        int slashIndex = cidr.IndexOf('/');
        string ipPart = slashIndex >= 0 ? cidr[..slashIndex] : cidr;
        int prefix = slashIndex >= 0 ? int.Parse(cidr[(slashIndex + 1)..]) : 128;

        if (!IPAddress.TryParse(ipPart, out var ip)) return null;
        var bytes = ip.GetAddressBytes();

        // Convert to BigInteger (big-endian)
        var beBytes = new byte[17]; // Extra zero byte for unsigned
        Array.Copy(bytes, 0, beBytes, 1, 16);
        Array.Reverse(beBytes);
        var addr = new BigInteger(beBytes);

        // Normalize to network address
        BigInteger mask = prefix == 0 ? BigInteger.Zero : (BigInteger.MinusOne << (128 - prefix));
        return (addr & mask, prefix);
    }

    private static string Uint32ToIpv4(uint addr)
    {
        return $"{(addr >> 24) & 0xFF}.{(addr >> 16) & 0xFF}.{(addr >> 8) & 0xFF}.{addr & 0xFF}";
    }

    private static string BigIntegerToIpv6(BigInteger addr)
    {
        var bytes = addr.ToByteArray();
        var ipBytes = new byte[16];

        // BigInteger is little-endian, IPAddress expects big-endian
        for (int i = 0; i < Math.Min(bytes.Length, 16); i++)
        {
            ipBytes[15 - i] = bytes[i];
        }

        return new IPAddress(ipBytes).ToString();
    }
}
