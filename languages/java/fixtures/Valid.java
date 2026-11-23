// Deliberately dependency-free: the provider smoke job exercises real PMD.
package sharedci.fixture;

public final class Valid {
    private Valid() {}

    public static int clamp(int value, int minimum, int maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }
}
