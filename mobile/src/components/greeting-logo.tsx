import { useEffect } from "react";
import Animated, { cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withTiming } from "react-native-reanimated";
import { Logo } from "@/components/icons";
import { theme } from "@/lib/theme";

// Navigation can mount the lockup more than once; a greeting belongs to launch.
let greeted = false;

export function GreetingLogo({ size = 42 }: { size?: number }) {
  const reducedMotion = useReducedMotion();
  const angle = useSharedValue(0);
  const lift = useSharedValue(0);
  useEffect(() => {
    if (greeted) return;
    greeted = true;
    if (reducedMotion) return;
    angle.value = withSequence(
      withTiming(-10, { duration: 220 }),
      withTiming(9, { duration: 190 }),
      withTiming(-5, { duration: 160 }),
      withTiming(3, { duration: 140 }),
      withTiming(0, { duration: 180 }),
    );
    lift.value = withSequence(withTiming(-4, { duration: 220 }), withTiming(0, { duration: 670 }));
    return () => { cancelAnimation(angle); cancelAnimation(lift); };
  }, [reducedMotion, angle, lift]);
  const greeting = useAnimatedStyle(() => ({ transform: [{ translateY: lift.value }, { rotate: `${angle.value}deg` }] }));
  return (
    <Animated.View accessibilityRole="image" accessibilityLabel="Shahi" style={greeting}>
      <Logo color={theme.peach} size={size} />
    </Animated.View>
  );
}
